const endpoint = 'https://kisyork.dethierhelene.workers.dev/';

export function createRecognizer(token, send = fetch) {
  if (!token) return undefined;
  return async (clip, mime, signal) => {
    const form = new FormData();
    form.set('file',new Blob([clip],{type:mime}),'extrait');
    const response = await send(endpoint,{
      method:'POST',headers:{Authorization:'Bearer ' + token},body:form,
      redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20_000)])
    });
    if (!response.ok) throw Error('Upstream unavailable');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32_768) {
        await reader.cancel();
        throw Error('Upstream response too large');
      }
      chunks.push(value);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (result?.match === false) return {match:false};
    if (result?.match !== true || typeof result.title !== 'string' || typeof result.artist !== 'string') {
      throw Error('Invalid recognition response');
    }
    return {match:true,title:result.title.slice(0,256),artist:result.artist.slice(0,256)};
  };
}
