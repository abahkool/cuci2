/* Shared helpers (classic script, attaches to window.CUCI) */
(function () {
  const C = (window.CUCI = window.CUCI || {});

  let seq = 0;
  C.uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}${(seq++).toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;

  C.clamp = (v, min, max) => Math.min(max, Math.max(min, v));

  C.fmt = (ms, digits = 3) => {
    ms = Math.max(0, Number(ms) || 0);
    const total = Math.round(ms);
    const h = Math.floor(total / 3600000);
    const m = Math.floor((total % 3600000) / 60000);
    const s = Math.floor((total % 60000) / 1000);
    const mil = total % 1000;
    const head = h > 0 ? `${h}:${String(m).padStart(2, '0')}` : `${m}`;
    const base = `${head}:${String(s).padStart(2, '0')}`;
    if (digits <= 0) return base;
    return `${base}.${String(mil).padStart(3, '0').slice(0, digits)}`;
  };

  C.fmtSigned = (ms) => (ms >= 0 ? '+' : '−') + C.fmt(Math.abs(ms), 3);

  C.basename = (p) => String(p).split(/[\\/]/).pop() || '';
  C.dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  C.stripExt = (n) => String(n).replace(/\.[^./\\]+$/, '');

  C.bytes = (n) => {
    if (!Number.isFinite(n)) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i++;
    }
    return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  };

  C.storageKey = 'cuci2.state.v1';

  C.escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
})();
