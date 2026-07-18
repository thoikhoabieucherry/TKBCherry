/*
  TKB engine shell.
  The old browser-side scheduling algorithm has been removed. Keep only helpers
  that create an empty timetable and apply fixed/off slots so the UI can still
  open, edit, save, and render existing data.
*/

function taoTKBTrong(){
  const tkb = {};
  DAYS.forEach(day => {
    tkb[day] = {
      sang: Array(SANG).fill(""),
      chieu: Array(CHIEU).fill("")
    };
  });
  return tkb;
}

function _cloneTkbShell(value){
  try{
    if(value && typeof value === "object") return JSON.parse(JSON.stringify(value));
  }catch(_){}
  return taoTKBTrong();
}

function _ensureTkbShape(tkb){
  const out = tkb && typeof tkb === "object" ? tkb : {};
  DAYS.forEach(day => {
    out[day] = out[day] && typeof out[day] === "object" ? out[day] : {};
    out[day].sang = Array.isArray(out[day].sang) ? out[day].sang : [];
    out[day].chieu = Array.isArray(out[day].chieu) ? out[day].chieu : [];
    while(out[day].sang.length < SANG) out[day].sang.push("");
    while(out[day].chieu.length < CHIEU) out[day].chieu.push("");
    out[day].sang = out[day].sang.slice(0, SANG);
    out[day].chieu = out[day].chieu.slice(0, CHIEU);
  });
  return out;
}

function _applyFixedAndOff(tkb, config){
  const out = _ensureTkbShape(tkb);
  const cfg = config && typeof config === "object" ? config : {};

  (cfg.fixed || []).forEach(item => {
    if(!item || !out[item.thu] || !Array.isArray(out[item.thu][item.buoi])) return;
    const index = Number(item.tiet);
    if(Number.isInteger(index) && index >= 0 && index < out[item.thu][item.buoi].length){
      out[item.thu][item.buoi][index] = {mon: item.ten || "", fixed: true};
    }
  });

  (cfg.off || []).forEach(item => {
    if(!item || !out[item.thu] || !Array.isArray(out[item.thu][item.buoi])) return;
    const index = Number(item.tiet);
    if(Number.isInteger(index) && index >= 0 && index < out[item.thu][item.buoi].length){
      out[item.thu][item.buoi][index] = "OFF";
    }
  });

  return out;
}

function taoTKBTheoConfig(_mons, config){
  return _applyFixedAndOff(taoTKBTrong(), config);
}

function taoTKBBoSungTheoConfig(existingTkb, _mons, config, _extraCanPlaceCell, _extraScoreBlock){
  return _applyFixedAndOff(_cloneTkbShell(existingTkb), config);
}

window.__TKB_BROWSER_SCHEDULER_REMOVED = true;
