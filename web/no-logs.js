(function(){
  "use strict";

  var enabled = false;
  try {
    enabled =
      window.TKB_ENABLE_LOGS === true ||
      window.localStorage?.getItem("TKB_ENABLE_LOGS") === "1";
  } catch (_) {
    enabled = false;
  }
  if (enabled || !window.console) return;

  var noop = function(){};
  ["log", "debug", "info", "trace"].forEach(function(name){
    try { window.console[name] = noop; } catch (_) {}
  });
})();
