const fs = require('fs');

const allSchools = JSON.parse(fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/e6e653cb-e567-476a-85f0-e418e6636dc4/scratch/all_vps_schools.json', 'utf8'));
const schoolData = allSchools['school_default'];

let engineCode = fs.readFileSync('web/pages/tkb-fet-engine.js', 'utf8');

// Let's inspect where randomSwap is called in the optimizer loops
// In optimize:
// When swapping act1 and act2, replace randomSwap with deterministic safe swaps that check isLessonBlockSafe!
