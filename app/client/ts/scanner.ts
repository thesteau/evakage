/** Validate a QR invitation without navigating to arbitrary scanned URLs. */
export function pairingInvitation(text: string, origin: string) {
  const url = new URL(text);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
    {throw new Error('Scan a pairing QR from this server.');}
  const params = new URLSearchParams(url.hash.slice(1));
  const code = params.get('pair');
  const device = params.get('device');
  if (!code || !/^[A-Z0-9-]{8,16}$/i.test(code) || !device || !/^[A-Za-z0-9_-]{43}$/.test(device))
    {throw new Error('This is not a device pairing QR.');}
  return { code, device };
}

/** A room invitation: this server's URL with the room code in the fragment. */
export function roomInvitation(text: string, origin: string) {
  const url = new URL(text);
  if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
    {throw new Error('Scan a QR from this server.');}
  const code = new URLSearchParams(url.hash.slice(1)).get('room');
  if (!code || !/^[A-Z0-9-]{8,16}$/i.test(code)) throw new Error('This is not a room QR.');
  return { code: code.toUpperCase() };
}

/** Builds the link a room QR carries. */
export function roomInvitationLink(code: string, base: string) {
  const url = new URL(base);
  url.search = '';
  url.hash = new URLSearchParams({ room: code }).toString();
  return url.toString();
}

export function setupScanner(handlers: {
  pair: (code: string, device: string) => Promise<void>;
  joinRoom: (code: string) => void;
}) {
  const dialog = document.querySelector('#scanQrDialog') as HTMLDialogElement;
  const video = document.querySelector('#scanQrVideo') as HTMLVideoElement;
  const status = document.querySelector('#scanQrStatus') as HTMLElement;
  let generation = 0;

  let stream: MediaStream | null = null;
  let timer = 0;
  const stop = () => {
    generation++;
    clearTimeout(timer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
    video.srcObject = null;
  };
  dialog.addEventListener('close', stop);
  window.addEventListener('pagehide', stop);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dialog.open) dialog.close();
  });
  const scanFrom = async () => {
    stop();
    const current = generation;
    dialog.showModal();
    status.textContent = 'Starting camera…';
    try {
      if (!navigator.mediaDevices?.getUserMedia)
        {throw new Error(
          'Camera scanning requires HTTPS or localhost. Enter the code instead.',
        );}
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      if (current !== generation || !dialog.open) {
        media.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = media;
      video.srcObject = media;
      await video.play();
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context)
        {throw new Error('Unable to read camera frames. Enter the code instead.');}
      status.textContent = 'Point the camera at a device or room QR.';
      const scan = async () => {
        if (current !== generation || !dialog.open) return;
        if (video.readyState >= 2 && video.videoWidth) {
          const scale = Math.min(1, 800 / video.videoWidth);
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const decoder = (
            window as Window & {
              jsQR?: (
                data: Uint8ClampedArray,
                width: number,
                height: number,
              ) => { data: string } | null;
            }
          ).jsQR;
          if (!decoder) {
            status.textContent = 'QR decoder unavailable. Enter the code instead.';
            stop();
            return;
          }
          const result = decoder(pixels.data, pixels.width, pixels.height);
          if (result) {
            const room = (() => {
              try {
                return roomInvitation(result.data, location.origin);
              } catch {
                return null;
              }
            })();
            try {
              const invitation = room ? null : pairingInvitation(result.data, location.origin);
              dialog.close();
              stop();
              if (room) handlers.joinRoom(room.code);
              else if (invitation) await handlers.pair(invitation.code, invitation.device);
              return;
            } catch {
              status.textContent = 'This is not an Evakage device or room QR from this server.';
            }
          }
        }
        timer = window.setTimeout(scan, 200);
      };
      await scan();
    } catch (error) {
      if (current === generation) {
        stop();
        status.textContent = `${error.message || 'Camera unavailable.'} You can enter the code instead.`;
      }
    }
  };
  for (const button of document.querySelectorAll('[data-scan-qr]')) {
    button.addEventListener('click', scanFrom);
  }
}
