//-------------progress-bar--------------

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("progress-bar-container");
  if (!container) return;

  const totalPoints = parseInt(container.dataset.total, 10) || 0;
  const rewards = safeParse(container.dataset.rewards) || [];
  const defaultSvg = container.dataset.defaultSvg || "/public/images/start-goal.svg";

  // Sécurité : tri par points (au cas où)
  rewards.sort((a, b) => (a.points_required || 0) - (b.points_required || 0));

  // Trouver "précédent" et "prochain" palier
  let prev = null;  // dernier palier atteint
  let next = null;  // prochain palier à atteindre

  for (let i = 0; i < rewards.length; i++) {
    const r = rewards[i];
    if (totalPoints < r.points_required) {
      next = r;
      prev = i > 0 ? rewards[i - 1] : null;
      break;
    }
  }
  // Si on a tout dépassé → prev = dernier, next = dernier (progression pleine)
  if (!next && rewards.length > 0) {
    prev = rewards[rewards.length - 1];
    next = rewards[rewards.length - 1];
  }

  // Mettre à jour la barre
  const indicator = document.getElementById("progress-indicator");
  const text = document.getElementById("progress-text");
  const startEl = document.getElementById("start-goal");
  const endEl = document.getElementById("end-goal");

  if (rewards.length === 0) {
    indicator.style.width = "0%";
    text.textContent = `${totalPoints}`;
    startEl.innerHTML = `<img src="${defaultSvg}" alt="start">`;
    endEl.innerHTML = "";
    return;
  }

  // Paliers en points
  const startPoints = prev ? prev.points_required : 0;
  const endPoints = next ? next.points_required : 0;

  let percent = 0;
  if (endPoints > startPoints) {
    percent = ((totalPoints - startPoints) / (endPoints - startPoints)) * 100;
  } else {
    // Cas "au-delà du dernier palier" ou palier unique
    percent = 100;
  }
  percent = Math.max(0, Math.min(100, percent));
  indicator.style.width = percent + "%";

  // Texte "nb / objectif"
  text.textContent = next
    ? `${Math.min(totalPoints, endPoints)}/${endPoints}`
    : `${totalPoints}`;

  // Icônes
  const startSvg = prev?.svg || defaultSvg;
  const endSvg = next?.svg || defaultSvg;

  startEl.innerHTML = `<img src="${startSvg}" alt="start reward">`;
  endEl.innerHTML = `<img src="${endSvg}" alt="end reward">`;
});

// Petit helper pour parser sans crash
function safeParse(json) {
  try { return JSON.parse(json); } catch { return null; }
}


//--------------nav-------------------

const sections = {
    'nav-quests': document.getElementById('quest-display'),
    'nav-gallery': document.getElementById('gallery-display'),
    'nav-awards': document.getElementById('award-display')
  };
const navItems = document.querySelectorAll('.nav-item');

navItems.forEach(item => {
    item.addEventListener('click', () => {
      // masquer toutes les sections
      Object.values(sections).forEach(sec => sec.style.display = 'none');

      // retirer la classe active de tous les boutons
      navItems.forEach(b => b.classList.remove('active'));


      // afficher la bonne section
      sections[item.id].style.display = 'flex';

      // activer le bouton
      item.classList.add('active');
    });
});

//-------------gallery lightbox---------------

const galleryItems = document.querySelectorAll('#gallery-display img');
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
const lightboxClose = document.getElementById('lightbox-close');

// Ouvrir lightbox
galleryItems.forEach(img => {
  img.addEventListener('click', () => {
    lightbox.style.display = 'flex';
    lightboxImg.src = img.src;
    lightboxDownload.dataset.filename = img.src.split('/').pop();
    lightboxDownload.textContent = isMobile ? 'Sauvegarder dans la Galerie' : 'Télécharger';
  });
});

// Fermer lightbox
lightboxClose.addEventListener('click', () => {
  lightbox.style.display = 'none';
});




//-----------upload quest img ----------------

document.addEventListener("DOMContentLoaded", () => {
  const questButtons = document.querySelectorAll(".submit-quest");
  const fileInput = document.getElementById("questUploadInput");
  const questForm = document.getElementById("questUploadForm");
  const questIdField = document.getElementById("questUploadQuestId");

  questButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const questId = btn.getAttribute("data-quest-id");
      questIdField.value = questId;
      fileInput.click(); // ouvre la boîte de dialogue
    });
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      questForm.submit(); // envoie vers /upload
    }
  });
});