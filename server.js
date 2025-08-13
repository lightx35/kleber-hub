/**
 * Serveur Express pour galerie photo
 * - Auth par appareil via cookie 'device_token'
 * - Upload d'images vers Cloudinary
 * - PostgreSQL pour stocker URLs et devices
 */
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Cloudinary config ---
if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.warn('⚠️ CLOUDINARY_* non configuré. Configurez vos variables d\'environnement.');
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- PostgreSQL ---
if (!process.env.DATABASE_URL) {
  console.warn('⚠️ DATABASE_URL non configurée. Configurez vos variables d\'environnement.');
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render Postgres requiert SSL
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY,
      device_token VARCHAR(64) UNIQUE NOT NULL,
      can_upload BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      device_id INTEGER REFERENCES devices(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Tables vérifiées.');
}

// --- Middleware device token ---
app.use(async (req, res, next) => {
  let token = req.cookies.device_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    // cookie 5 ans, httpOnly
    const isSecure = req.protocol === 'https' || (req.get('x-forwarded-proto') === 'https');
    res.cookie('device_token', token, {
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax'
    });
  }
  req.deviceToken = token;

  // Ensure device exists in DB
  try {
    await pool.query(
      'INSERT INTO devices (device_token) VALUES ($1) ON CONFLICT (device_token) DO NOTHING',
      [token]
    );
  } catch (e) {
    console.error('DB error creating device:', e);
  }
  next();
});

// --- Helper: get device + check rights ---
async function getCurrentDevice(token) {
  const { rows } = await pool.query('SELECT * FROM devices WHERE device_token = $1', [token]);
  return rows[0] || null;
}
async function isAllowedToUpload(token) {
  const d = await getCurrentDevice(token);
  return d && d.can_upload === true;
}

// --- Multer (mémoire) ---
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 Mo
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') cb(null, true);
    else cb(new Error('Formats autorisés: JPG, PNG'));
  }
});

// --- Routes ---
app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM photos ORDER BY uploaded_at DESC LIMIT 200');
    const canUpload = await isAllowedToUpload(req.deviceToken);
    res.render('index', { photos: rows, canUpload });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur');
  }
});

app.get('/authorize', async (req, res) => {
  res.render('authorize', { ok: false, error: '' });
});

app.post('/authorize', async (req, res) => {
  const code = (req.body.code || '').trim();
  if (!process.env.ADMIN_CODE) {
    return res.status(500).send('ADMIN_CODE non configuré');
  }
  if (Buffer.from(process.env.ADMIN_CODE).length === Buffer.from(code).length &&
      crypto.timingSafeEqual(Buffer.from(process.env.ADMIN_CODE), Buffer.from(code))) {
    try {
      const d = await getCurrentDevice(req.deviceToken);
      if (!d) return res.render('authorize', { ok: false, error: 'Appareil introuvable.' });
      await pool.query('UPDATE devices SET can_upload = TRUE WHERE id = $1', [d.id]);
      return res.render('authorize', { ok: true, error: '' });
    } catch (e) {
      console.error(e);
      return res.render('authorize', { ok: false, error: 'Erreur base de données.' });
    }
  } else {
    return res.render('authorize', { ok: false, error: 'Code incorrect.' });
  }
});

app.post('/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!await isAllowedToUpload(req.deviceToken)) {
      return res.status(403).send('Accès refusé.');
    }
    if (!req.file) return res.redirect('/');

    // Upload vers Cloudinary
    const uploadStream = cloudinary.uploader.upload_stream(
      { folder: 'node_render_site', resource_type: 'image' },
      async (error, result) => {
        if (error) {
          console.error('Cloudinary error:', error);
          return res.status(500).send('Erreur upload Cloudinary.');
        }
        const filename = result.public_id.split('/').pop();
        const url = result.secure_url;
        // Lier à l'appareil
        const d = await getCurrentDevice(req.deviceToken);
        const deviceId = d ? d.id : null;
        await pool.query(
          'INSERT INTO photos (filename, url, device_id) VALUES ($1, $2, $3)',
          [filename, url, deviceId]
        );
        return res.redirect('/');
      }
    );
    uploadStream.end(req.file.buffer);
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur.');
  }
});

// Démarrage
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur port ${PORT}`);
  });
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
