/*
  phanmon-ops shell.
  The old browser-side auto-scheduling and optimization routines were removed.
  Core manual timetable editing/rendering remains in phanmon.js. The Rust bridge
  loaded after this file owns the automatic scheduling button and calls the
  backend simple fill-non-off scheduler.
*/

(function(){
  "use strict";

  const MESSAGE = "Bo xep local cu da tat. Hay chay backend va tai lai trang de dung nut Sap xep moi.";

  function notifyRemoved(){
    try{
      if(typeof window.showBottomPopup === "function"){
        window.showBottomPopup(MESSAGE, "warning");
        return null;
      }
    }catch(_){}
    try{ alert(MESSAGE); }catch(_){}
    return null;
  }

  function setStatusRemoved(){
    try{
      const el = document.getElementById("statusMsg");
      if(el) el.textContent = MESSAGE;
    }catch(_){}
  }

  function noopScore(){
    return 0;
  }

  function noopOptimize(){
    setStatusRemoved();
    return 0;
  }

  async function removedAsync(){
    setStatusRemoved();
    notifyRemoved();
    return null;
  }

  function removedSync(){
    setStatusRemoved();
    notifyRemoved();
    return null;
  }

  window.__PHANMON_OPS_VERSION = "clean-no-scheduler-2026-06-24";
  window.__PHANMON_OPS_SCHEDULER_REMOVED = true;

  window.makeExtraScoreBlockForTeacherQuality = function(){
    return noopScore;
  };
  window.makeExtraScoreBlockForTeacherQualityAndSpread = function(){
    return noopScore;
  };

  window.optimizeTeacherScheduleQuality = noopOptimize;
  window.optimizeTeacherScheduleQualityBuoi1 = noopOptimize;
  window.optimizeTeacherScheduleQualityAdvanced = noopOptimize;

  window.sapXepTuDongAll = removedAsync;
  window.xepLaiLop = removedSync;
  window.openTuyChinh = removedSync;
  window.runOptimizeFromPanel = removedAsync;
  window.continueOptimizeFromPanel = removedAsync;
  window.xepTheoTuyChinh = removedSync;
  window.stopOptimize = function(){ return null; };

  console.log("[phanmon-ops] scheduler removed");
})();
