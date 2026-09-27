'use strict';

(() => {
  const DATA = window.DEVICE_DATA;
  if (!DATA) {
    document.body.innerHTML = '<p style="padding:2rem">没有找到 assets/devices.js，请先运行 tools/build_assets.py 生成素材。</p>';
    return;
  }

  const MODELS = DATA.models;
  const modelById = new Map(MODELS.map((m) => [m.id, m]));
  const $ = (sel) => document.querySelector(sel);
  const MAX_CANVAS_AREA = 16_000_000;   // iOS Safari 的画布面积上限附近

  // ---------------- 设置（记住上次的选择） ----------------

  const STORE_KEY = 'bezel-studio:settings:v1';
  const DEFAULTS = {
    model: 'iphone-17-pro', color: 'cosmic-orange',
    orient: 'auto', top: 'left', fit: 'cover',
    bg: 'transparent', bgCustom: '#E8ECF2', pad: 0, shadow: false,
    scale: '1', format: 'png', autoMatch: true,
  };
  const settings = { ...DEFAULTS, ...readStore() };
  if (!modelById.has(settings.model)) settings.model = modelById.has(DEFAULTS.model) ? DEFAULTS.model : MODELS[0].id;
  if (!currentModel().colors.some((c) => c.id === settings.color)) settings.color = currentModel().colors[0].id;

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
  }
  function saveStore() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* 隐私模式等 */ }
  }

  function currentModel() { return modelById.get(settings.model); }
  function currentColor() {
    const m = currentModel();
    return m.colors.find((c) => c.id === settings.color) || m.colors[0];
  }

  // ---------------- 截图 ----------------

  const shots = [];
  let currentId = null;
  let viewFamily = currentModel().family;
  let seq = 0;

  const currentShot = () => shots.find((s) => s.id === currentId) || null;

  function screenMatches(model, shot) {
    const a = Math.min(shot.w, shot.h), b = Math.max(shot.w, shot.h);
    return model.screen[0] === a && model.screen[1] === b;
  }

  function effectiveOrient(shot) {
    if (settings.orient !== 'auto') return settings.orient;
    return shot && shot.w > shot.h ? 'landscape' : 'portrait';
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) { toast('没有识别到图片文件'); return; }
    let first = null;
    for (const file of files) {
      const url = URL.createObjectURL(file);
      try {
        const img = await decodeImage(url);
        const shot = {
          id: ++seq, url, img,
          name: file.name && file.name !== 'image.png' ? file.name : `粘贴的截图 ${seq}.png`,
          w: img.naturalWidth, h: img.naturalHeight,
        };
        shots.push(shot);
        first = first || shot;
      } catch {
        URL.revokeObjectURL(url);
        toast(`无法读取「${file.name}」，请确认是 PNG / JPG 图片`);
      }
    }
    if (first) selectShot(first.id);
  }

  function selectShot(id) {
    currentId = id;
    const shot = currentShot();
    if (shot) autoMatch(shot);
    renderStrip();
    syncControls();
    scheduleRender();
  }

  function removeShot(id) {
    const i = shots.findIndex((s) => s.id === id);
    if (i < 0) return;
    URL.revokeObjectURL(shots[i].url);
    shots.splice(i, 1);
    if (currentId === id) currentId = (shots[i] || shots[i - 1] || {}).id ?? null;
    renderStrip();
    syncControls();
    scheduleRender();
  }

  function autoMatch(shot) {
    if (!settings.autoMatch || screenMatches(currentModel(), shot)) return;
    const match = MODELS.find((m) => screenMatches(m, shot));
    if (!match) return;
    const prevColor = currentColor();
    settings.model = match.id;
    const same = match.colors.find((c) => c.id === prevColor.id);
    settings.color = (same || match.colors[0]).id;
    viewFamily = match.family;
    saveStore();
    renderModelPicker();
    toast(`已按截图尺寸切换到 ${modelLabel(match)}`);
  }

  function modelLabel(m) { return m.variant ? `${m.name} ${m.variant}` : m.name; }

  // ---------------- 图片与边框几何 ----------------

  const imageCache = new Map();
  function decodeImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`加载失败：${src}`));
      img.src = src;
    });
  }
  function loadAsset(src) {
    if (!imageCache.has(src)) {
      const p = decodeImage(src).catch((e) => { imageCache.delete(src); throw e; });
      imageCache.set(src, p);
    }
    return imageCache.get(src);
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // 顺时针旋转 deg（0/90/180/270）
  function rotateImage(img, W, H, deg) {
    if (!deg) return img;
    const c = deg % 180 ? makeCanvas(H, W) : makeCanvas(W, H);
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -W / 2, -H / 2);
    return c;
  }
  function rotateRect([x, y, w, h], W, H, deg) {
    switch (deg) {
      case 90: return [H - (y + h), x, h, w];
      case 180: return [W - (x + w), H - (y + h), w, h];
      case 270: return [y, W - (x + w), h, w];
      default: return [x, y, w, h];
    }
  }

  // 选出素材并算出需要的旋转角度。top = 横屏时机身顶部朝向
  function pickAsset(color, orient, top) {
    if (orient === 'landscape') {
      if (color.landscape) return { asset: color.landscape, deg: color.landscape.top === top ? 0 : 180 };
      return { asset: color.portrait, deg: top === 'left' ? 270 : 90 };
    }
    if (color.portrait) return { asset: color.portrait, deg: 0 };
    return { asset: color.landscape, deg: color.landscape.top === 'left' ? 90 : 270 };
  }

  const geoCache = new Map();
  function getGeometry(model, color, orient, top) {
    const key = [model.id, color.id, orient, orient === 'landscape' ? top : ''].join('|');
    if (!geoCache.has(key)) {
      const { asset, deg } = pickAsset(color, orient, top);
      const p = Promise.all([loadAsset(asset.src), loadAsset(asset.mask)]).then(([bezel, mask]) => {
        const [W, H] = asset.size;
        return {
          key,
          bezel: rotateImage(bezel, W, H, deg),
          mask: rotateImage(mask, W, H, deg),
          W: deg % 180 ? H : W,
          H: deg % 180 ? W : H,
          screen: rotateRect(asset.screen, W, H, deg),
        };
      });
      p.catch(() => geoCache.delete(key));
      geoCache.set(key, p);
      while (geoCache.size > 10) geoCache.delete(geoCache.keys().next().value);
    }
    return geoCache.get(key);
  }

  function isCached(model, color, orient, top) {
    return geoCache.has([model.id, color.id, orient, orient === 'landscape' ? top : ''].join('|'));
  }

  // ---------------- 合成 ----------------

  // 在 scale 倍率下画出「截图 + 蒙版 + 边框」
  function renderDevice(geo, shot, scale) {
    const c = makeCanvas(geo.W * scale, geo.H * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const [x, y, w, h] = geo.screen;

    ctx.save();
    ctx.scale(c.width / geo.W, c.height / geo.H);
    // 先铺黑底，垫在边框抗锯齿内沿下，也作为「完整显示」时的黑边
    ctx.fillStyle = '#000';
    ctx.fillRect(x - 6, y - 6, w + 12, h + 12);
    if (shot) drawFitted(ctx, shot, x, y, w, h);
    ctx.restore();

    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(geo.mask, 0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(geo.bezel, 0, 0, c.width, c.height);
    return c;
  }

  function drawFitted(ctx, shot, x, y, w, h) {
    const { img, w: iw, h: ih } = shot;
    if (iw === w && ih === h) { ctx.drawImage(img, x, y); return; }
    if (settings.fit === 'stretch') { ctx.drawImage(img, x, y, w, h); return; }
    if (settings.fit === 'contain') {
      const k = Math.min(w / iw, h / ih);
      const dw = iw * k, dh = ih * k;
      ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      return;
    }
    const k = Math.max(w / iw, h / ih);
    const sw = w / k, sh = h / k;
    ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
  }

  function padPx(geo) { return Math.round((settings.pad / 100) * Math.min(geo.W, geo.H)); }

  function backgroundFill(format) {
    if (settings.bg === 'transparent') return format === 'jpeg' ? '#FFFFFF' : null;
    return settings.bg === 'custom' ? settings.bgCustom : settings.bg;
  }

  // 把设备图放到最终画布上（背景、留白、阴影）
  function compose(target, device, geo, scale, format = settings.format) {
    const pad = Math.round(padPx(geo) * scale);
    target.width = device.width + pad * 2;
    target.height = device.height + pad * 2;
    const ctx = target.getContext('2d');
    ctx.clearRect(0, 0, target.width, target.height);
    const fill = backgroundFill(format);
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(0, 0, target.width, target.height); }
    if (settings.shadow) {
      const m = Math.min(device.width, device.height);
      ctx.shadowColor = 'rgba(0, 0, 0, 0.32)';
      ctx.shadowBlur = m * 0.07;
      ctx.shadowOffsetY = m * 0.025;
    }
    ctx.drawImage(device, pad, pad);
    return pad;
  }

  function exportScale(geo) {
    let s = Number(settings.scale) || 1;
    const pad = padPx(geo);
    const area = (geo.W + pad * 2) * (geo.H + pad * 2) * s * s;
    if (area > MAX_CANVAS_AREA) s *= Math.sqrt(MAX_CANVAS_AREA / area);
    return s;
  }

  // ---------------- 预览 ----------------

  const els = {
    stage: $('#stage'), viewport: $('#viewport'), frame: $('#frame'), canvas: $('#preview'),
    dropzone: $('#dropzone'), spinner: $('#spinner'), info: $('#info'),
    strip: $('#strip'), stripList: $('#stripList'),
    families: $('#families'), models: $('#models'), swatches: $('#swatches'), colorName: $('#colorName'),
    topRow: $('#topRow'), fitHint: $('#fitHint'), pad: $('#pad'), padOut: $('#padOut'),
    shadow: $('#shadow'), autoMatch: $('#autoMatch'), bgCustom: $('#bgCustom'), customChip: $('#customChip'),
    outSize: $('#outSize'), downloadBtn: $('#downloadBtn'), copyBtn: $('#copyBtn'), zipBtn: $('#zipBtn'),
    fileInput: $('#fileInput'), toast: $('#toast'),
  };

  let renderToken = 0;
  let rafId = 0;
  let deviceMemo = { key: '', canvas: null };

  function scheduleRender() {
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(render);
  }

  async function render() {
    const token = ++renderToken;
    const shot = currentShot();
    const model = currentModel(), color = currentColor();
    const orient = effectiveOrient(shot);

    const needsLoad = !isCached(model, color, orient, settings.top);
    const slow = needsLoad ? setTimeout(() => { if (token === renderToken) els.spinner.hidden = false; }, 150) : 0;
    let geo;
    try {
      geo = await getGeometry(model, color, orient, settings.top);
    } catch (e) {
      if (token === renderToken) toast(`边框素材加载失败：${e.message}`);
      return;
    } finally {
      clearTimeout(slow);
      if (token === renderToken) els.spinner.hidden = true;
    }
    if (token !== renderToken) return;

    // 按可用空间算出显示尺寸，预览只按屏幕像素渲染
    const cs = getComputedStyle(els.viewport);
    const boxW = els.viewport.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const boxH = els.viewport.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const padFull = padPx(geo);
    const outW = geo.W + padFull * 2, outH = geo.H + padFull * 2;
    const k = Math.max(0.01, Math.min(boxW / outW, boxH / outH));
    els.frame.style.width = `${Math.floor(outW * k)}px`;
    els.frame.style.height = `${Math.floor(outH * k)}px`;

    const scale = Math.min(1, k * (window.devicePixelRatio || 1));
    const memoKey = [geo.key, shot ? shot.id : '-', settings.fit, scale.toFixed(4)].join('|');
    if (deviceMemo.key !== memoKey) deviceMemo = { key: memoKey, canvas: renderDevice(geo, shot, scale) };
    compose(els.canvas, deviceMemo.canvas, geo, scale);

    placeDropzone(geo, padFull, outW, k, !shot);
    renderInfo(shot, geo, model);
    const s = exportScale(geo);
    els.outSize.textContent = `输出 ${Math.round(outW * s)} × ${Math.round(outH * s)} px`;
  }

  function placeDropzone(geo, pad, outW, k, visible) {
    els.dropzone.hidden = !visible;
    if (!visible) return;
    const [x, y, w, h] = geo.screen;
    Object.assign(els.dropzone.style, {
      left: `${(pad + x) * k}px`, top: `${(pad + y) * k}px`,
      width: `${w * k}px`, height: `${h * k}px`,
    });
    const short = Math.min(w, h) * k;
    els.dropzone.style.setProperty('--dz-r', `${short * 0.13}px`);
    els.dropzone.style.setProperty('--dz-inset', `${Math.max(8, short * 0.06)}px`);
  }

  function renderInfo(shot, geo, model) {
    const [, , sw, sh] = geo.screen;
    const num = (a, b) => `<span class="num">${a} × ${b}</span>`;
    if (!shot) {
      els.info.innerHTML = `${escapeHtml(modelLabel(model))} · 屏幕 ${num(sw, sh)}`;
      return;
    }
    let status;
    if (shot.w === sw && shot.h === sh) {
      status = '<span class="ok">与屏幕尺寸一致</span>';
    } else if (Math.abs(shot.w / shot.h - sw / sh) < 0.004) {
      status = `按比例缩放到 ${num(sw, sh)}`;
    } else {
      const how = { cover: '已填充并裁切边缘', contain: '已完整显示并补黑边', stretch: '已拉伸' }[settings.fit];
      status = `比例与屏幕 ${num(sw, sh)} 不同，${how}`;
    }
    els.info.innerHTML = `${escapeHtml(shot.name)} · ${num(shot.w, shot.h)} · ${status}`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // ---------------- 面板 ----------------

  function h(tag, attrs = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') el.style.cssText = v;
      else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of [].concat(children)) if (c) el.append(c);
    return el;
  }

  // 重建单选列表后把焦点还给同一组，方便用方向键连续切换
  function keepFocus(fn) {
    const a = document.activeElement;
    const name = a && a.type === 'radio' ? a.name : null;
    fn();
    if (name && !document.activeElement?.name) {
      const target = document.querySelector(`input[name="${name}"]:checked`) || document.querySelector(`input[name="${name}"]`);
      target?.focus();
    }
  }

  function renderModelPicker() { keepFocus(renderModelPickerNow); }
  function renderModelPickerNow() {
    const shot = currentShot();
    const matchSet = new Set(shot ? MODELS.filter((m) => screenMatches(m, shot)).map((m) => m.id) : []);

    els.families.replaceChildren(...DATA.families.map((f) => {
      const hasMatch = MODELS.some((m) => m.family === f && matchSet.has(m.id));
      const input = h('input', { type: 'radio', name: 'family', value: f, checked: f === viewFamily });
      return h('label', { class: `chip${hasMatch ? ' has-match' : ''}`, title: hasMatch ? '有与截图尺寸一致的机型' : null },
        [input, h('span', { text: f === 'Duo' ? 'Duo' : f })]);
    }));

    const list = MODELS.filter((m) => m.family === viewFamily);
    els.models.replaceChildren(...list.map((m) => {
      const input = h('input', { type: 'radio', name: 'model', value: m.id, checked: m.id === settings.model });
      const name = h('span', { class: 'model-name', text: m.name }, m.variant ? h('small', { text: m.variant }) : null);
      const orients = m.colors.some((c) => c.landscape) ? '竖屏 / 横屏' : '竖屏（横屏自动旋转）';
      const meta = h('span', { class: 'model-meta' }, [
        h('span', { text: `${m.colors.length} 种颜色 · ${orients}` }),
        matchSet.has(m.id) ? h('span', { class: 'match', text: '尺寸匹配' }) : null,
      ]);
      return h('label', { class: 'model' }, [input, name, h('span', { class: 'model-res', text: `${m.screen[0]}×${m.screen[1]}` }), meta]);
    }));

    renderSwatches();
  }

  function renderSwatches() {
    const m = currentModel();
    els.swatches.replaceChildren(...m.colors.map((c) => {
      const input = h('input', { type: 'radio', name: 'color', value: c.id, checked: c.id === settings.color, 'aria-label': c.name });
      return h('label', { class: 'swatch', title: `${c.name} ${c.en}` }, [input, h('span', { style: `--c:${c.hex}` })]);
    }));
    const c = currentColor();
    els.colorName.replaceChildren(document.createTextNode(c.name), h('small', { text: c.en }));
    document.body.style.setProperty('--finish', c.hex);
  }

  function renderStrip() {
    els.strip.hidden = shots.length === 0;
    els.stage.classList.toggle('has-shots', shots.length > 0);
    els.stripList.replaceChildren(...shots.map((s) => {
      const btn = h('button', { class: 'thumb-btn', type: 'button', title: `${s.name}（${s.w}×${s.h}）`, 'aria-label': `查看 ${s.name}` },
        h('img', { src: s.url, alt: '' }));
      btn.addEventListener('click', () => selectShot(s.id));
      const x = h('button', { class: 'thumb-x', type: 'button', 'aria-label': `移除 ${s.name}`, text: '×' });
      x.addEventListener('click', () => removeShot(s.id));
      return h('div', { class: `thumb${s.id === currentId ? ' is-current' : ''}` }, [btn, x]);
    }));
    const cur = els.stripList.querySelector('.is-current');
    if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function syncControls() {
    for (const name of ['orient', 'top', 'fit', 'bg', 'scale', 'format']) {
      for (const input of document.querySelectorAll(`input[name="${name}"]`)) input.checked = input.value === String(settings[name]);
    }
    els.pad.value = settings.pad;
    els.padOut.textContent = `${settings.pad}%`;
    els.shadow.checked = settings.shadow;
    els.autoMatch.checked = settings.autoMatch;
    els.bgCustom.value = settings.bgCustom;
    els.customChip.style.setProperty('--c', settings.bgCustom);

    const shot = currentShot();
    els.topRow.hidden = effectiveOrient(shot) !== 'landscape';
    els.fitHint.textContent = '只在截图比例和屏幕不一致时生效';

    renderModelPicker();

    const none = shots.length === 0;
    els.downloadBtn.disabled = none;
    els.copyBtn.disabled = none;
    els.zipBtn.hidden = shots.length < 2;
    els.zipBtn.textContent = `全部下载（${shots.length} 张，ZIP）`;
  }

  // ---------------- 导出 ----------------

  async function exportShot(shot, format = settings.format) {
    const model = currentModel(), color = currentColor();
    const geo = await getGeometry(model, color, effectiveOrient(shot), settings.top);
    const scale = exportScale(geo);
    const out = document.createElement('canvas');
    compose(out, renderDevice(geo, shot, scale), geo, scale, format);
    const mime = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve, reject) => {
      try {
        out.toBlob((b) => (b ? resolve(b) : reject(new Error('生成图片失败'))), mime, 0.95);
      } catch (e) { reject(e); }
    });
    const base = shot.name.replace(/\.[^.]+$/, '');
    const ext = format === 'jpeg' ? 'jpg' : 'png';
    return { blob, name: `${base}_${model.id}_${color.id}.${ext}` };
  }

  function explainExportError(e) {
    if (e && e.name === 'SecurityError') {
      $('#fileNotice').hidden = false;
      return '浏览器阻止了从本地文件导出，请通过 start.command 启动后再试';
    }
    return `导出失败：${(e && e.message) || e}`;
  }

  function saveBlob(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  async function withBusy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { await fn(); } finally { btn.textContent = old; btn.disabled = shots.length === 0; }
  }

  els.downloadBtn.addEventListener('click', () => {
    const shot = currentShot();
    if (!shot) return;
    withBusy(els.downloadBtn, '正在生成…', async () => {
      try {
        const { blob, name } = await exportShot(shot);
        saveBlob(blob, name);
        toast(`已下载 ${name}`);
      } catch (e) { toast(explainExportError(e)); }
    });
  });

  els.copyBtn.addEventListener('click', () => {
    const shot = currentShot();
    if (!shot) return;
    if (!navigator.clipboard || !window.ClipboardItem) {
      toast('当前浏览器不支持复制图片，请用「下载图片」');
      return;
    }
    // Safari 要求在点击事件里同步调用 clipboard.write，所以传入 Promise
    const blobPromise = exportShot(shot, 'png').then((r) => r.blob);
    withBusy(els.copyBtn, '复制中…', async () => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })]);
        toast('已复制到剪贴板（PNG）');
      } catch (e) { toast(e && e.name === 'SecurityError' ? explainExportError(e) : `复制失败：${e.message || e}`); }
    });
  });

  els.zipBtn.addEventListener('click', () => {
    withBusy(els.zipBtn, '正在打包…', async () => {
      try {
        const files = [];
        const used = new Set();
        for (const [i, shot] of shots.entries()) {
          els.zipBtn.textContent = `正在生成 ${i + 1}/${shots.length}…`;
          const { blob, name } = await exportShot(shot);
          let unique = name, n = 2;
          while (used.has(unique)) unique = name.replace(/(\.\w+)$/, `-${n++}$1`);
          used.add(unique);
          files.push({ name: unique, data: new Uint8Array(await blob.arrayBuffer()) });
        }
        const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
        saveBlob(makeZip(files), `带壳截图_${stamp}.zip`);
        toast(`已打包 ${files.length} 张图片`);
      } catch (e) { toast(explainExportError(e)); }
    });
  });

  // 不压缩（store）的最小 ZIP 实现，PNG 本身已压缩
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function makeZip(files) {
    const enc = new TextEncoder();
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const parts = [], central = [];
    let offset = 0, centralSize = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data), size = f.data.length;
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);          // 文件名使用 UTF-8
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, size, true);
      local.setUint32(22, size, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, f.data);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, size, true);
      cen.setUint32(24, size, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen, name);
      centralSize += 46 + name.length;
      offset += 30 + name.length + size;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type: 'application/zip' });
  }

  // ---------------- 交互绑定 ----------------

  function update(patch) {
    Object.assign(settings, patch);
    saveStore();
    syncControls();
    scheduleRender();
  }

  document.querySelector('.panel').addEventListener('change', (e) => {
    const t = e.target;
    switch (t.name) {
      case 'family':
        viewFamily = t.value;
        renderModelPicker();
        return;
      case 'model': {
        const m = modelById.get(t.value);
        const same = m.colors.find((c) => c.id === settings.color);
        update({ model: m.id, color: (same || m.colors[0]).id });
        return;
      }
      case 'color': update({ color: t.value }); return;
      case 'orient': case 'top': case 'fit': case 'bg': case 'scale': case 'format':
        update({ [t.name]: t.value });
        if (t.name === 'bg' && t.value === 'custom') els.bgCustom.click();
        return;
      default:
    }
    if (t === els.shadow) update({ shadow: t.checked });
    else if (t === els.autoMatch) {
      update({ autoMatch: t.checked });
      const shot = currentShot();
      if (t.checked && shot) { autoMatch(shot); syncControls(); scheduleRender(); }
    }
  });

  els.pad.addEventListener('input', () => update({ pad: Number(els.pad.value) }));
  els.bgCustom.addEventListener('input', () => update({ bg: 'custom', bgCustom: els.bgCustom.value }));
  els.customChip.addEventListener('click', (e) => {
    if (settings.bg === 'custom') { e.preventDefault(); els.bgCustom.click(); }
  });

  const openPicker = () => els.fileInput.click();
  $('#addBtn').addEventListener('click', openPicker);
  $('#stripAdd').addEventListener('click', openPicker);
  els.dropzone.addEventListener('click', openPicker);
  els.fileInput.addEventListener('change', () => {
    if (els.fileInput.files.length) addFiles(els.fileInput.files);
    els.fileInput.value = '';
  });

  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); addFiles(files); }
  });

  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    els.stage.classList.add('dragging');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.stage.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.stage.classList.remove('dragging');
    addFiles(e.dataTransfer.files);
  });

  // 左右方向键切换截图
  document.addEventListener('keydown', (e) => {
    if (!shots.length || e.target.closest('input, .panel')) return;
    const i = shots.findIndex((s) => s.id === currentId);
    if (e.key === 'ArrowRight' && i < shots.length - 1) selectShot(shots[i + 1].id);
    else if (e.key === 'ArrowLeft' && i > 0) selectShot(shots[i - 1].id);
  });

  new ResizeObserver(scheduleRender).observe(els.viewport);

  let toastTimer = 0;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2800);
  }

  if (location.protocol === 'file:') $('#fileNotice').hidden = false;

  syncControls();
  scheduleRender();
})();
