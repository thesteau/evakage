// Info icons ([data-tip]) keep explanations out of the way until asked for.
// One shared popover renders the text: popovers sit in the top layer, so the
// tip shows above an open modal dialog and is never clipped by it.
let tip: HTMLElement | null = null;
let owner: HTMLElement | null = null;

export function setTip(icon: HTMLElement, text: string) {
  icon.dataset.tip = text;
  icon.setAttribute('aria-label', text);
  if (owner === icon && tip) tip.textContent = text;
}

function hide() {
  owner = null;
  if (tip?.matches(':popover-open')) tip.hidePopover();
}

function show(icon: HTMLElement) {
  if (!tip || !icon.dataset.tip) return;
  owner = icon;
  tip.textContent = icon.dataset.tip;
  if (!tip.matches(':popover-open')) tip.showPopover();
  const anchor = icon.getBoundingClientRect();
  const gap = 8;
  const left = Math.min(
    Math.max(gap, anchor.left + anchor.width / 2 - tip.offsetWidth / 2),
    innerWidth - tip.offsetWidth - gap,
  );
  const below = anchor.bottom + gap;
  const top =
    below + tip.offsetHeight > innerHeight - gap ? anchor.top - gap - tip.offsetHeight : below;
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(gap, top)}px`;
}

export function setupTips() {
  if (!('showPopover' in HTMLElement.prototype)) return;
  tip = document.createElement('div');
  tip.className = 'info-tip-text';
  tip.setAttribute('popover', 'manual');
  tip.setAttribute('role', 'tooltip');
  document.body.append(tip);
  for (const icon of document.querySelectorAll<HTMLElement>('[data-tip]')) {
    setTip(icon, icon.dataset.tip || '');
  }
  const iconOf = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLElement>('[data-tip]') : null;
  document.addEventListener('pointerover', (event) => {
    const icon = iconOf(event.target);
    if (event.pointerType === 'mouse' && icon) show(icon);
  });
  document.addEventListener('pointerout', (event) => {
    if (event.pointerType === 'mouse' && iconOf(event.target) === owner) hide();
  });
  document.addEventListener('focusin', (event) => {
    const icon = iconOf(event.target);
    if (icon) show(icon);
  });
  document.addEventListener('focusout', (event) => {
    if (iconOf(event.target) === owner) hide();
  });
  // Tapping toggles the tip. Icons sit inside <label>s, so the click must not
  // also toggle the setting it explains.
  document.addEventListener('click', (event) => {
    const icon = iconOf(event.target);
    if (!icon) {
      hide();
      return;
    }
    event.preventDefault();
    if (owner === icon && (event as PointerEvent).pointerType !== 'mouse') hide();
    else show(icon);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && owner) hide();
  });
  // Closing the dialog an icon lives in takes its tip with it.
  document.addEventListener('close', hide, true);
  addEventListener('resize', hide);
}
