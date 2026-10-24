import io

p = 'lib/e2e.js'
s = io.open(p, encoding='utf-8').read()

# ── xss import: confirm step ─────────────────────────────────────
old = """      document.getElementById('jobPaste').value = code;
      document.getElementById('jobImport').click();
      await wait(900);
"""
new = """      document.getElementById('jobPaste').value = code;
      document.getElementById('jobImport').click();
      await wait(500);
      // Importing now opens a confirmation summarising the sanitized job.
      const confirmVisible = !document.getElementById('confirmModal').classList.contains('hidden');
      const confirmText = document.getElementById('confirmRows').textContent;
      const confirmInjected = document.querySelectorAll('#confirmRows img, #confirmRows svg, #confirmRows script').length;
      document.getElementById('confirmOk').click();
      await wait(900);
"""
assert old in s
s = s.replace(old, new, 1)

old = """        statusHasImgTag: /<img/i.test(document.getElementById('statusText').textContent),
"""
if old not in s:
    # fall back: append fields to the returned object before its closing brace
    raise SystemExit('statusHasImgTag anchor missing')
s = s.replace(old, old + """        confirmVisible,
        confirmText,
        confirmInjected,
""", 1)

# ── xss assertions ──────────────────────────────────────────────
old = """    xss.bodyHasArrow === true &&
    xss.statusHasImgTag === false;"""
new = """    xss.bodyHasArrow === true &&
    xss.statusHasImgTag === false &&
    xss.confirmVisible === true &&
    xss.confirmInjected === 0 &&
    /INJECTED|hello/i.test(xss.confirmText);"""
assert old in s
s = s.replace(old, new, 1)

# ── appearance block: user guide ────────────────────────────────
old = """      out.backToEnglish = $('btnExport').textContent === 'Export' && document.documentElement.dir === 'ltr';
      $('expClose');
      $('setClose').click();
      await wait(150);
      return out;"""
new = """      out.backToEnglish = $('btnExport').textContent === 'Export' && document.documentElement.dir === 'ltr';
      // user guide (button + F1), translated with the current language
      $('btnGuide').click();
      await wait(200);
      out.guideOpen = !document.getElementById('guideModal').classList.contains('hidden');
      out.guideSections = document.querySelectorAll('#guideModal .guide-section').length;
      out.guideShortcuts = document.querySelectorAll('#guideModal .guide-keys tr').length;
      out.guideTitleEn = document.querySelector('#guideModal h2').textContent;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F1', bubbles: true }));
      await wait(150);
      out.guideF1Closed = document.getElementById('guideModal').classList.contains('hidden');
      $('btnGuide').click();
      await wait(150);
      $('setLanguage').value = 'ms';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      out.guideTitleMs = document.querySelector('#guideModal h2').textContent;
      $('setLanguage').value = 'en';
      $('setLanguage').dispatchEvent(new Event('change', { bubbles: true }));
      await wait(250);
      document.getElementById('guideClose2').click();
      await wait(150);
      out.guideClosed = document.getElementById('guideModal').classList.contains('hidden');
      $('expClose');
      $('setClose').click();
      await wait(150);
      return out;"""
assert old in s
s = s.replace(old, new, 1)

old = """    appearanceInfo.backToEnglish;
  const formatOk ="""
new = """    appearanceInfo.backToEnglish &&
    appearanceInfo.guideOpen &&
    appearanceInfo.guideSections >= 8 &&
    appearanceInfo.guideShortcuts >= 12 &&
    appearanceInfo.guideTitleEn === 'User guide' &&
    appearanceInfo.guideF1Closed &&
    appearanceInfo.guideTitleMs === 'Panduan Pengguna' &&
    appearanceInfo.guideClosed;
  const formatOk ="""
assert old in s
s = s.replace(old, new, 1)

io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('ok')
