const login = document.getElementById('login-pop-up-background');


document.getElementById('login-link').onclick = () => {
  login.style.display = 'flex';
};

login.onclick = (e) => {
  if (e.target === login) {
    login.style.display = 'none';
  }
};