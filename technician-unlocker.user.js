// ==UserScript==
// @name         Technician unlocker (te factureren fix) v1.1
// @namespace    https://groupwise.cerepair.nl/
// @version      1.1
// @description  Shows ✏️ button when Technician select is disabled; click to unlock.
// @author       you
// @match        https://groupwise.cerepair.nl/*
// @run-at       document-end
// @grant        none
//
// Optional (recommended for GitHub auto-updates):
// @homepageURL  https://github.com/Lex-Dorosh/NodeRED>
// @supportURL   https://github.com/Lex-Dorosh/NodeRED/issues
// @downloadURL  https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/technician-unlocker.user.js
// @updateURL    https://raw.githubusercontent.com/Lex-Dorosh/NodeRED/main/technician-unlocker.user.js
// ==/UserScript==

(function () {
  'use strict';

  function setupTechnicianUnlocker() {
    const techSelect = document.getElementById('lst_technician');
    if (!techSelect) return;

    const tr = techSelect.closest('tr');
    if (!tr) return;

    const labelTd = tr.querySelector('td');
    if (!labelTd) return;

    function updatePencil() {
      let pencil = labelTd.querySelector('.tm-tech-pencil');

      if (!techSelect.disabled) {
        if (pencil) pencil.remove();
        return;
      }

      if (pencil) return;

      pencil = document.createElement('button');
      pencil.type = 'button';
      pencil.textContent = '✏️';
      pencil.title = 'Technician wijzigen (veld ontgrendelen)';
      pencil.className = 'tm-tech-pencil';

      Object.assign(pencil.style, {
        marginLeft: '5px',
        padding: '0 4px',
        border: '1px solid #999',
        borderRadius: '3px',
        background: '#f0f0f0',
        cursor: 'pointer',
        fontSize: '10px'
      });

      pencil.addEventListener('click', function () {
        techSelect.disabled = false;
        techSelect.removeAttribute('disabled');

        const oldBg = techSelect.style.backgroundColor;
        techSelect.style.backgroundColor = '#ffffcc';
        setTimeout(() => {
          techSelect.style.backgroundColor = oldBg || '';
        }, 800);

        updatePencil();
      });

      labelTd.appendChild(pencil);
    }

    updatePencil();

    const observer = new MutationObserver(() => {
      updatePencil();
    });

    observer.observe(techSelect, {
      attributes: true,
      attributeFilter: ['disabled']
    });
  }

  window.addEventListener('load', () => {
    setTimeout(setupTechnicianUnlocker, 500);
  });
})();
