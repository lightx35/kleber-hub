/**
 * Serveur Express pour galerie photo (version avec users)
 * - Auth par utilisateur (users) + devices connus dans la table users
 * - Upload d'images vers Cloudinary
 * - PostgreSQL pour stocker URLs et utilisateurs
 */

const fs = require('fs');
const exif = require('exif-parser');
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const multer = require('multer');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const bcrypt = require('bcrypt');


dotenv.config();

const app = express();
const PORT = process.env.PORT || 10000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/public', express.static(path.join(__dirname, 'public')));

// --- Cloudinary config ---
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// --- PostgreSQL ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Render Postgres requiert SSL
});

// --- initialisation DB ---
async function initDb() {
  // table users
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(50) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      devices TEXT[],
      profile_pic TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // table photos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS photos (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      taken_at TIMESTAMPTZ,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // table pending_photos
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pending_photos (
      id SERIAL PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      url TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      device_token TEXT,
      quest_id INTEGER,
      taken_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // table quests
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quests (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      type TEXT,
      points INTEGER DEFAULT 0,
      start_at TIMESTAMPTZ,
      end_at TIMESTAMPTZ,
      active BOOLEAN DEFAULT TRUE
    );
  `);

  // table global_progress
  await pool.query(`
    CREATE TABLE IF NOT EXISTS global_progress (
      id SERIAL PRIMARY KEY,
      points INTEGER DEFAULT 0
    );
  `);

  // table rewards
  await pool.query(`
    CREATE TABLE IF NOT EXISTS rewards (
      id SERIAL PRIMARY KEY,
      points_required INTEGER,
      description TEXT
    );
  `);

  console.log('✅ Toutes les tables vérifiées/créées');
}

// --- Middleware device token ---
app.use((req, res, next) => {
  let token = req.cookies.device_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('hex');
    const isSecure = req.protocol === 'https' || (req.get('x-forwarded-proto') === 'https');
    res.cookie('device_token', token, {
      maxAge: 1000 * 60 * 60 * 24 * 365 * 5,
      httpOnly: true,
      secure: isSecure,
      sameSite: 'lax'
    });
  }
  req.deviceToken = token;
  next();
});

// Middleware pour vérifier si l'utilisateur est connecté
async function requireLogin(req, res, next) {
  const user = await getUserByDevice(req.deviceToken);
  if (!user) {
    return res.redirect('/'); // redirige à l'accueil si pas connecté
  }
  req.user = user; // stocke l'utilisateur pour les routes
  next();
}

// Middleware pour restreindre l'accès à l'admin à Nicolas
async function requireAdmin(req, res, next) {
  const user = await getUserByDevice(req.deviceToken);
  if (!user) {
    return res.redirect('/'); // pas connecté
  }

  if (user.username !== 'Nicolas') {
    return res.status(403).send('Accès refusé'); // utilisateur non autorisé
  }

  req.user = user; // stocke l'utilisateur
  next();
}

// --- Helper: récupérer l’utilisateur depuis son device ---
async function getUserByDevice(token) {
  const { rows } = await pool.query(
    `SELECT * FROM users WHERE $1 = ANY(devices) LIMIT 1`,
    [token]
  );
  return rows[0] || null;
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

app.get('/admin', requireAdmin, async (req, res) => {
  try {
    const pending = (await pool.query('SELECT p.*, u.username FROM pending_photos p LEFT JOIN users u ON p.user_id = u.id ORDER BY p.created_at DESC')).rows;
    const users = (await pool.query('SELECT id, username FROM users ORDER BY username')).rows;
    const quests = (await pool.query('SELECT * FROM quests ORDER BY id DESC')).rows;
    const progress = (await pool.query('SELECT points FROM global_progress WHERE id = 1')).rows[0];

    res.render('admin', { pending, users, quests, progress });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur admin');
  }
});

app.post('/admin/pending/:id/approve', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Récupérer la pending photo + quest points
    const { rows } = await client.query(
      `SELECT p.*, q.points as quest_points
       FROM pending_photos p
       LEFT JOIN quests q ON p.quest_id = q.id
       WHERE p.id = $1 FOR UPDATE`, [id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).send('Pending photo introuvable');
    }
    const pending = rows[0];
    const pts = pending.quest_points || 0;

    // Insérer dans photos
    await client.query(
      `INSERT INTO photos (filename, url, user_id, taken_at)
       VALUES ($1, $2, $3, $4)`, [pending.filename, pending.url, pending.user_id, pending.taken_at]
    );

    // Mettre à jour progress global
    if (pts > 0) {
      await client.query(`UPDATE global_progress SET points = points + $1 WHERE id = 1`, [pts]);
    }

    // Supprimer pending
    await client.query(`DELETE FROM pending_photos WHERE id = $1`, [id]);

    await client.query('COMMIT');
    res.redirect('/admin');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Approve failed', err);
    res.status(500).send('Erreur approbation');
  } finally {
    client.release();
  }
});

app.post('/admin/pending/:id/reject', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // (option) récupérer public_id pour suppression Cloudinary
    const { rows } = await pool.query('SELECT filename FROM pending_photos WHERE id = $1', [id]);
    if (rows.length === 0) return res.redirect('/admin');

    const filename = rows[0].filename;
    // delete from cloudinary if desired:
    // await cloudinary.uploader.destroy(`pending_uploads/${filename}`);

    await pool.query('DELETE FROM pending_photos WHERE id = $1', [id]);
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur rejet');
  }
});

app.post('/admin/photo/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    // Option: récupérer url/filename pour destroy sur Cloudinary
    const { rows } = await pool.query('SELECT filename FROM photos WHERE id = $1', [id]);
    if (rows[0]) {
      const filename = rows[0].filename;
      // await cloudinary.uploader.destroy(`uploads/${filename}`);
    }

    await pool.query('DELETE FROM photos WHERE id = $1', [id]);
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur suppression photo');
  }
});


app.post('/admin/users/create', requireAdmin, async (req, res) => {
  const { username, password, profile_pic } = req.body;
  if (!username || !password) return res.status(400).send('Missing');
  try {
    const passHash = await bcrypt.hash(password, 10);
    await pool.query(
      `INSERT INTO users (username, password_hash, devices, profile_pic) VALUES ($1, $2, $3, $4)`,
      [username, passHash, '{}', profile_pic || null]
    );
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur création user');
  }
});

app.post('/admin/users/:id/delete', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    await pool.query('DELETE FROM users WHERE id = $1', [id]);
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur suppression user');
  }
});

app.post('/admin/quests/create', requireAdmin, async (req, res) => {
  const { title, points, start_at, end_at } = req.body;
  try {
    await pool.query(
      `INSERT INTO quests (title, description, type, points, start_at, end_at, active)
       VALUES ($1, $2, 'weekly', $3, $4, $5, true)`,
      [title, '', parseInt(points,10) || 0, start_at, end_at]
    );
    res.redirect('/admin');
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur création quest');
  }
});

// --- Route index ---
app.get('/', async (req, res) => {
  try {
    // Récupération de l'utilisateur courant via le device token
    const user = await getUserByDevice(req.deviceToken);

    // Affichage de la vue index.ejs
    res.render('index', { user });
  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur');
  }
});

// --- Route Toilet App ---
app.get('/toilet-app', requireLogin, async (req, res) => {
  try {
    // Récupération des photos avec le nom de l'utilisateur
    const { rows } = await pool.query(`
      SELECT photos.*, users.username, users.profile_pic
      FROM photos
      JOIN users ON photos.user_id = users.id
      ORDER BY COALESCE(taken_at, uploaded_at) DESC
      LIMIT 200
    `);

    const progressRow = (await pool.query('SELECT points FROM global_progress WHERE id = 1')).rows[0];
    const totalPoints = progressRow ? parseInt(progressRow.points,10) : 0;
    const rewards = (await pool.query('SELECT * FROM rewards ORDER BY points_required')).rows;

    // render with totalPoints & rewards
    res.render('toilet-app', { photos: rows, user: req.user, totalPoints, rewards });

  } catch (e) {
    console.error(e);
    res.status(500).send('Erreur serveur');
  }
});

// route upload
app.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.redirect('/');

    const user = await getUserByDevice(req.deviceToken);
    if (!user) return res.status(403).send('Vous devez être connecté pour uploader.');

    // EXIF
    let takenDate = null;
    try {
      const parser = exif.create(req.file.buffer);
      const result = parser.parse();
      if (result.tags && result.tags.DateTimeOriginal) {
        takenDate = new Date(result.tags.DateTimeOriginal * 1000);
      }
    } catch (ex) {
      console.warn('Impossible de lire EXIF:', ex.message);
    }

    // upload Cloudinary depuis buffer
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "pending_uploads" },
        (error, result) => error ? reject(error) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    const filename = uploadResult.public_id.split('/').pop();
    const url = uploadResult.secure_url;

    // récupère l’ID de quête
    const questId = req.body.quest_id || null; 

    // sauvegarde dans pending_photos
    await pool.query(
      `INSERT INTO pending_photos (filename, url, user_id, device_token, quest_id, taken_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [filename, url, user.id, req.deviceToken, questId, takenDate]
    );

    // feedback utilisateur
    res.redirect('/toilet-app'); // ou une page de confirmation
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).send(`Erreur upload: ${err.message}`);
}
});

// Route login

app.post('/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    // Vérifier si l'utilisateur existe
    const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = rows[0];

    if (!user) {
      return res.status(401).send("Utilisateur introuvable");
    }

    // Vérifier le mot de passe
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).send("Mot de passe incorrect");
    }

    // Associer le device_token à l’utilisateur
    const token = req.deviceToken;
    await pool.query(
      `UPDATE users SET devices = array_append(devices, $1) WHERE id = $2 AND NOT ($1 = ANY(devices))`,
      [token, user.id]
    );

    // Stocker l'ID utilisateur en cookie pour la session
    res.cookie("user_id", user.id, { httpOnly: true });

    // Rediriger vers l'accueil
    res.redirect('/');
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur serveur");
  }
});

// Route logout
app.get('/logout', (req, res) => {
  // Supprimer les cookies
  res.clearCookie("user_id");
  res.clearCookie("device_token"); // si tu veux aussi forcer un nouveau device_token

  // Rediriger vers l'accueil
  res.redirect('/');
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