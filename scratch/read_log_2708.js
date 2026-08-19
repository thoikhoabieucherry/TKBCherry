const fs = require('fs');
const log = fs.readFileSync('C:/Users/Love/.gemini/antigravity/brain/7f45a0c4-c524-4db2-abf1-1af8bc7c8182/.system_generated/tasks/task-2708.log', 'utf8');
const lines = log.split('\n').filter(l => l.includes('Singletons improved'));
console.log(lines.slice(0, 30).join('\n'));
console.log('...');
console.log(lines.slice(-30).join('\n'));
