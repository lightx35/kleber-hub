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

// Ouvrir la lightbox au clic
galleryItems.forEach(img => {
  img.addEventListener('click', () => {
    lightbox.style.display = 'flex';
    lightboxImg.src = img.src; // récupère l'image cliquée
  });
});

// Fermer en cliquant sur le bouton ✖
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