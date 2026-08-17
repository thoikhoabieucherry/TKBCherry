const fs = require("fs");
const path = require("path");

const data = JSON.parse(fs.readFileSync(path.resolve(__dirname, "excel_data_parsed.json"), "utf8"));
console.log("Class 9/13 Thu 5 chieu:", data.tkb["9/13"]?.["thu5"]?.["chieu"]);
