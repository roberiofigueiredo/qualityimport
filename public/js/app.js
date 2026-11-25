// Melhorias progressivas: tudo funciona sem JavaScript; aqui só deixamos mais prático.
(function () {
  'use strict';

  // ---------- Diálogo de confirmação (substitui window.confirm)
  function confirmDialog(message) {
    return new Promise(function (resolve) {
      var dlg = document.createElement('dialog');
      dlg.className = 'qi-dialog';
      dlg.innerHTML = '<p></p><div class="actions-bar"><button type="button" class="btn btn-ghost" data-no>Cancelar</button><button type="button" class="btn btn-danger" data-yes>Confirmar</button></div>';
      dlg.querySelector('p').textContent = message;
      document.body.appendChild(dlg);
      function done(v) { dlg.close(); dlg.remove(); resolve(v); }
      dlg.querySelector('[data-yes]').addEventListener('click', function () { done(true); });
      dlg.querySelector('[data-no]').addEventListener('click', function () { done(false); });
      dlg.addEventListener('cancel', function () { done(false); });
      if (dlg.showModal) dlg.showModal(); else resolve(true);
    });
  }

  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-confirm]');
    if (!btn || btn.dataset.confirmed) return;
    ev.preventDefault();
    confirmDialog(btn.dataset.confirm).then(function (ok) {
      if (!ok) return;
      btn.dataset.confirmed = '1';
      btn.click();
    });
  });

  // ---------- Público-alvo: mostra filiais/setores só quando "selecionados"
  document.querySelectorAll('[data-audience]').forEach(function (fs) {
    var pick = fs.querySelector('[data-audience-pick]');
    function sync() {
      var sel = fs.querySelector('input[name=publico]:checked');
      pick.hidden = !sel || sel.value !== 'selecionado';
    }
    fs.addEventListener('change', sync);
    sync();
  });

  // ---------- Editor de texto formatado
  document.querySelectorAll('[data-editor]').forEach(function (ed) {
    var area = ed.querySelector('.editor-area');
    var src = ed.querySelector('.editor-source');
    if (!document.execCommand) return;
    ed.classList.add('is-rich');
    area.innerHTML = src.value;
    ed.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('click', function () {
        area.focus();
        var cmd = b.dataset.cmd;
        if (cmd === 'createLink') {
          var url = window.prompt('Endereço do link (https://...)');
          if (url) document.execCommand('createLink', false, url);
        } else {
          document.execCommand(cmd, false, b.dataset.value ? '<' + b.dataset.value + '>' : null);
        }
        src.value = area.innerHTML;
      });
    });
    area.addEventListener('input', function () { src.value = area.innerHTML; });
    var form = ed.closest('form');
    if (form) form.addEventListener('submit', function () { src.value = area.innerHTML; });
  });

  // ---------- Aviso ao sair com alterações não salvas
  document.querySelectorAll('form[data-unsaved]').forEach(function (form) {
    var dirty = false;
    form.addEventListener('input', function () { dirty = true; });
    form.addEventListener('change', function () { dirty = true; });
    form.addEventListener('submit', function () { dirty = false; });
    window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  });

  // ---------- Pré-visualização das fotos selecionadas
  document.querySelectorAll('[data-photo-input]').forEach(function (input) {
    var box = input.closest('[data-dropzone]').querySelector('[data-upload-preview]');
    input.addEventListener('change', function () {
      box.innerHTML = '';
      Array.prototype.slice.call(input.files, 0, 50).forEach(function (f) {
        if (!/^image\//.test(f.type)) return;
        var img = document.createElement('img');
        img.alt = f.name;
        img.src = URL.createObjectURL(f);
        box.appendChild(img);
      });
    });
  });

  // ---------- Copiar link de convite
  document.querySelectorAll('[data-copy]').forEach(function (inp) {
    inp.addEventListener('focus', function () { inp.select(); });
  });

  // ---------- Menu do celular: fecha ao escolher uma seção
  document.querySelectorAll('.mobile-menu').forEach(function (m) {
    m.addEventListener('click', function (e) { if (e.target.closest('a')) m.open = false; });
  });

  // ---------- Busca instantânea de lojas no site público
  var storeForm = document.querySelector('[data-store-search]');
  if (storeForm) {
    var input = storeForm.querySelector('input[name=busca]');
    var city = storeForm.querySelector('select[name=cidade]');
    var count = document.querySelector('[data-store-count]');
    var cards = Array.prototype.slice.call(document.querySelectorAll('[data-store]'));
    var filter = function () {
      var q = (input.value || '').trim().toLowerCase();
      var c = city ? city.value : '';
      var n = 0;
      cards.forEach(function (card) {
        var ok = (!q || card.dataset.store.indexOf(q) > -1) && (!c || card.dataset.city === c);
        card.hidden = !ok;
        if (ok) n++;
      });
      if (count) count.textContent = n + ' de ' + cards.length + ' loja(s)';
    };
    input.addEventListener('input', filter);
    if (city) city.addEventListener('change', filter);
  }

  // ---------- Loja mais próxima (geolocalização do navegador, nada é enviado ao servidor)
  var geoBtn = document.querySelector('[data-geo]');
  var storesBox = document.querySelector('[data-stores]');
  if (geoBtn && storesBox && navigator.geolocation && storesBox.querySelector('[data-lat]')) {
    geoBtn.hidden = false;
    var toast = function (msg) {
      var t = document.querySelector('.toast') || document.body.appendChild(Object.assign(document.createElement('div'), { className: 'toast' }));
      t.setAttribute('role', 'status'); t.textContent = msg; t.hidden = false;
      clearTimeout(t._h); t._h = setTimeout(function () { t.hidden = true; }, 4500);
    };
    var km = function (a, b, c, d) { var R = 6371, r = Math.PI / 180, x = Math.sin((c - a) * r / 2), y = Math.sin((d - b) * r / 2); return 2 * R * Math.asin(Math.sqrt(x * x + Math.cos(a * r) * Math.cos(c * r) * y * y)); };
    geoBtn.addEventListener('click', function () {
      geoBtn.disabled = true;
      navigator.geolocation.getCurrentPosition(function (pos) {
        geoBtn.disabled = false;
        var lat = pos.coords.latitude, lng = pos.coords.longitude;
        var cards = Array.prototype.slice.call(storesBox.querySelectorAll('.store-card'));
        var dist = function (c) { return c.dataset.lat ? km(lat, lng, +c.dataset.lat, +c.dataset.lng) : 1e9; };
        cards.sort(function (a, b) { return dist(a) - dist(b); }).forEach(function (c, k) {
          var badge = c.querySelector('.distance'), d = dist(c);
          if (badge && d < 1e9) { badge.textContent = (d < 10 ? d.toFixed(1).replace('.', ',') : Math.round(d)) + ' km'; badge.hidden = false; }
          c.hidden = false;
          c.classList.toggle('nearest', k === 0);
          storesBox.appendChild(c);
        });
        toast('Lojas ordenadas da mais próxima para a mais distante.');
        cards[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, function () {
        geoBtn.disabled = false;
        toast('Não foi possível obter sua localização. Busque pelo nome da cidade ou bairro.');
      }, { timeout: 10000 });
    });
  }

  // ---------- Lightbox da galeria (toque/arraste no celular, setas no teclado)
  var grid = document.querySelector('[data-lightbox]');
  if (grid) {
    var items = Array.prototype.slice.call(grid.querySelectorAll('[data-lightbox-item]'));
    var lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.hidden = true;
    lb.setAttribute('role', 'dialog');
    lb.setAttribute('aria-modal', 'true');
    lb.setAttribute('aria-label', 'Foto ampliada');
    lb.innerHTML = '<span class="lb-count"></span><button class="lb-close" aria-label="Fechar">×</button><button class="lb-prev" aria-label="Foto anterior">‹</button><img alt=""><button class="lb-next" aria-label="Próxima foto">›</button><div class="lightbox-caption"></div>';
    document.body.appendChild(lb);
    var img = lb.querySelector('img');
    var cap = lb.querySelector('.lightbox-caption');
    var cnt = lb.querySelector('.lb-count');
    var idx = 0;
    var show = function (i) {
      idx = (i + items.length) % items.length;
      img.src = items[idx].getAttribute('href');
      img.alt = items[idx].dataset.caption || '';
      cap.textContent = items[idx].dataset.caption || '';
      cnt.textContent = (idx + 1) + ' / ' + items.length;
    };
    var open = function (i) { show(i); lb.hidden = false; document.body.style.overflow = 'hidden'; lb.querySelector('.lb-close').focus(); };
    var close = function () { lb.hidden = true; document.body.style.overflow = ''; items[idx].focus(); };
    items.forEach(function (a, i) {
      a.addEventListener('click', function (e) { e.preventDefault(); open(i); });
    });
    lb.querySelector('.lb-close').addEventListener('click', close);
    lb.querySelector('.lb-prev').addEventListener('click', function () { show(idx - 1); });
    lb.querySelector('.lb-next').addEventListener('click', function () { show(idx + 1); });
    lb.addEventListener('click', function (e) { if (e.target === lb) close(); });
    document.addEventListener('keydown', function (e) {
      if (lb.hidden) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(idx - 1);
      if (e.key === 'ArrowRight') show(idx + 1);
    });
    var x0 = null;
    lb.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (x0 === null) return;
      var dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) show(idx + (dx < 0 ? 1 : -1));
      x0 = null;
    });
  }
})();
