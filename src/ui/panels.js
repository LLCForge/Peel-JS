const MAX_FILE_BYTES = 20 * 1024 * 1024;

const main = document.getElementById('main');
const input = document.getElementById('input');
const output = document.getElementById('output');
const divider = document.getElementById('divider');
const fileInput = document.getElementById('file');
const [inputPanel, , outputPanel] = main.children;

export const els = { input, output, fileInput };

export function initPanels({ onInputChange, onOutputChange, onError }) {
  const drop = document.createElement('div');
  drop.id = 'drop';
  const label = document.createElement('span');
  label.dataset.i18n = 'drop';
  drop.appendChild(label);
  input.parentElement.appendChild(drop);

  input.addEventListener('input', () => onInputChange(input.value.length));
  output.addEventListener('input', () => onOutputChange(output.value.length));

  const setSplit = (pct) => {
    const p = Math.max(20, Math.min(80, pct));
    inputPanel.style.flex = `0 0 ${p}%`;
    outputPanel.style.flex = `0 0 calc(${100 - p}% - 4px)`;
    divider.setAttribute('aria-valuenow', String(Math.round(p)));
  };
  let drag = false;
  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = true;
    divider.classList.add('drag');
    divider.setPointerCapture(e.pointerId);
  });
  divider.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = main.getBoundingClientRect();
    setSplit(((e.clientX - r.left) / r.width) * 100);
  });
  divider.addEventListener('pointerup', () => { drag = false; divider.classList.remove('drag'); });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const current = Number(divider.getAttribute('aria-valuenow') ?? 50);
    setSplit(current + (e.key === 'ArrowLeft' ? -5 : 5));
  });

  for (const ev of ['dragenter', 'dragover']) {
    input.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('on'); });
  }
  for (const ev of ['dragleave', 'drop']) input.addEventListener(ev, () => drop.classList.remove('on'));
  input.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) readFile(f, onError);
  });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) readFile(f, onError);
    fileInput.value = '';
  });
}

async function readFile(file, onError) {
  if (file.size > MAX_FILE_BYTES) {
    onError(`Dosya ${MAX_FILE_BYTES / 1024 / 1024} MB sınırını aşıyor`);
    return;
  }
  try {
    input.value = await file.text();
    input.dispatchEvent(new Event('input'));
  } catch {
    onError('Dosya okunamadı');
  }
}

export function setOutput(text) {
  output.value = text;
  output.dispatchEvent(new Event('input'));
}
