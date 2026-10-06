/** Validate a QR invitation without navigating to arbitrary scanned URLs.
 * @param {string} text @param {string} origin */
export function pairingInvitation(text, origin) {
  const url = new URL(text);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol)) throw new Error('Scan a pairing QR from this server.');
  const params = new URLSearchParams(url.hash.slice(1));
  const code = params.get('pair');
  const device = params.get('device');
  if (!code || !/^[A-Z0-9-]{8,16}$/i.test(code) || !device || !/^[A-Za-z0-9_-]{43}$/.test(device)) throw new Error('This is not a device pairing QR.');
  return { code, device };
}

/** @param {(code: string, device: string) => Promise<void>} pair */
export function setupScanner(pair) {
  const dialog = /** @type {HTMLDialogElement} */ (document.querySelector('#scanQrDialog'));
  const video = /** @type {HTMLVideoElement} */ (document.querySelector('#scanQrVideo'));
  const status = /** @type {HTMLElement} */ (document.querySelector('#scanQrStatus'));
  let generation = 0;
  /** @type {MediaStream | null} */
  let stream = null;
  let timer = 0;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
  };
  dialog.addEventListener('close', stop);
  window.addEventListener('pagehide', stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden && dialog.open) dialog.close(); });
  document.querySelector('#scanQrBtn')?.addEventListener('click', async () => {
    stop();
    const current = generation;
    dialog.showModal();
    status.textContent = 'Starting camera…';
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera scanning requires HTTPS or localhost. Enter the pairing code instead.');
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      if (current !== generation || !dialog.open) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      video.srcObject = media;
      await video.play();
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('Unable to read camera frames. Enter the pairing code instead.');
      status.textContent = 'Point the camera at a device pairing QR.';
      const scan = async () => {
        if (current !== generation || !dialog.open) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 800 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const decoder = /** @type {Window & {jsQR?: (data: Uint8ClampedArray, width: number, height: number) => {data: string} | null}} */ (window).jsQR;
          if (!decoder) { status.textContent = 'QR decoder unavailable. Enter the pairing code instead.'; stop(); return; }
          const result = decoder(pixels.data, pixels.width, pixels.height);
          if (result) {
            try {
              const invitation = pairingInvitation(result.data, location.origin);
              dialog.close(); stop();
              await pair(invitation.code, invitation.device);
              return;
            } catch (error) { status.textContent = error.message; }
          }
        }
        timer = window.setTimeout(scan, 200);
      };
      await scan();
    } catch (error) {
      if (current === generation) { stop(); status.textContent = `${error.message || 'Camera unavailable.'} You can enter the pairing code instead.`; }
    }
  });
}
