/*
 * dropdowns.js - small accessible visual wrapper for native selects.
 *
 * The native select remains the source of truth so the existing application
 * listeners keep working. This wrapper only owns the visible button and menu.
 */
(function () {
  'use strict';

  function enhance(select) {
    if (!select || select.dataset.customised) return;
    select.dataset.customised = 'true';

    var wrapper = document.createElement('div');
    wrapper.className = 'custom-select';
    select.parentNode.insertBefore(wrapper, select);
    wrapper.appendChild(select);

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');

    var menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.setAttribute('role', 'listbox');

    function sync() {
      var selected = select.options[select.selectedIndex];
      trigger.childNodes[0] && (trigger.childNodes[0].nodeValue = selected ? selected.text : '');
      Array.prototype.forEach.call(menu.children, function (option, index) {
        var active = index === select.selectedIndex;
        option.classList.toggle('is-selected', active);
        option.setAttribute('aria-selected', active ? 'true' : 'false');
      });
    }

    trigger.appendChild(document.createTextNode(''));
    trigger.addEventListener('click', function () {
      var open = wrapper.classList.toggle('open');
      trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        var current = menu.children[select.selectedIndex];
        if (current) current.focus();
      }
    });

    Array.prototype.forEach.call(select.options, function (sourceOption, index) {
      var option = document.createElement('div');
      option.className = 'custom-select-option';
      option.textContent = sourceOption.text;
      option.setAttribute('role', 'option');
      option.setAttribute('tabindex', '0');
      option.addEventListener('click', function () {
        select.selectedIndex = index;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        wrapper.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
        trigger.focus();
      });
      option.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          option.click();
        } else if (event.key === 'Escape') {
          wrapper.classList.remove('open');
          trigger.setAttribute('aria-expanded', 'false');
          trigger.focus();
        }
      });
      menu.appendChild(option);
    });

    select.addEventListener('change', sync);
    wrapper.appendChild(trigger);
    wrapper.appendChild(menu);
    sync();
  }

  Array.prototype.forEach.call(document.querySelectorAll('select'), enhance);
  document.addEventListener('click', function (event) {
    document.querySelectorAll('.custom-select.open').forEach(function (wrapper) {
      if (!wrapper.contains(event.target)) {
        wrapper.classList.remove('open');
        wrapper.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
      }
    });
  });
})();
