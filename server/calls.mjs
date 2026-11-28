import {createHmac,randomUUID} from 'node:crypto';

export function createCalls({turnUrl, turnSecret, second, eligible}) {
  if (turnUrl || turnSecret) {
    if (typeof turnUrl !== 'string' || !/^turns:[a-z0-9.-]+:\d{2,5}\?transport=tcp$/i.test(turnUrl) ||
      typeof turnSecret !== 'string' || turnSecret.length < 32) {
      throw Error('Configurer une URL TURN TLS et un secret TURN aléatoire.');
    }
  }
  const calls = new Map();
  function fail(status,message) {
    return {status,body:{error:message}};
  }
  function cleaned() {
    for (const [id, call] of calls) {
      if (call.expires <= second() || !eligible(call.from,call.to)) calls.delete(id);
    }
  }
  const forUser = id => [...calls.values()].find(call => call.from === id || call.to === id);
  function configuration() {
    const username = String(second() + 600) + ':' + randomUUID();
    return {iceTransportPolicy:'relay',iceServers:[{urls:[turnUrl],username,
      credential:createHmac('sha1',turnSecret).update(username).digest('base64')}]};
  }
  function validDescription(sdp) {
    if (typeof sdp !== 'string' || sdp.length > 24_000 || !sdp.startsWith('v=0')) return false;
    const candidates = sdp.split(/\r?\n/).filter(line => line.startsWith('a=candidate:'));
    return candidates.length > 0 && candidates.every(line => /\btyp relay\b/.test(line));
  }
  return {
    process(action, account, data, target) {
      cleaned();
      if (!turnUrl) return action === 'status' ? {body:{available:false,call:null}} : fail(503,'Relais TURN indisponible.');
      const current = forUser(account.id);
      if (action === 'status') {
        const call = current && {
          id: current.id, direction: current.from === account.id ? 'outgoing' : 'incoming',
          from:current.fromName,to:current.toName,kind:current.kind,offer:current.offer,answer:current.answer
        };
        return {body:{available:true,call:call ?? null}};
      }
      if (action === 'ice') return {body:configuration()};
      if (action === 'offer') {
        if (!target || !eligible(account.id,target.id)) return fail(404,'Contact indisponible.');
        if (current || forUser(target.id) || calls.size >= 100) return fail(409,'Un appel est déjà en cours.');
        if (!['audio','video'].includes(data.kind) || !validDescription(data.sdp)) return fail(400,'Offre média invalide.');
        const id = randomUUID();
        calls.set(id,{id,from:account.id,to:target.id,fromName:account.handle,toName:target.handle,
          kind:data.kind,offer:data.sdp,answer:null,expires:second()+60});
        return {status:201,body:{id}};
      }
      if (!current || current.id !== data.id) return fail(404,'Appel indisponible.');
      if (action === 'answer') {
        if (current.to !== account.id || current.answer || !validDescription(data.sdp)) return fail(400,'Réponse média invalide.');
        current.answer = data.sdp;
        current.expires = second()+600;
      } else if (action === 'end') {
        calls.delete(current.id);
      } else {
        return fail(400,'Action invalide.');
      }
      return {body:{}};
    }
  };
}
