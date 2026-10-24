const fs = require('fs');

// 1. Fix Chat.jsx so groupMembers is always an Array
let c = fs.readFileSync('src/Chat.jsx', 'utf8');
c = c.replace('const groupMembers = useChatStore((s) => s.groupMembers) || [];', 'const rawGroupMembers = useChatStore((s) => s.groupMembers);\n  const groupMembers = Array.isArray(rawGroupMembers) ? rawGroupMembers : [];');
c = c.replace(/\(groupMembers \|\| \[\]\)\.map/g, '(Array.isArray(groupMembers) ? groupMembers : []).map');
c = c.replace(/groupMembers\.map\(\(m\) => \(/g, '(Array.isArray(groupMembers) ? groupMembers : []).map((m) => (');
fs.writeFileSync('src/Chat.jsx', c);

// 2. Fix useNIP29Group.js so it never crashes when adding members
let u = fs.readFileSync('src/hooks/useNIP29Group.js', 'utf8');
u = u.replace(/let updated = \[\.\.\.prev\];/g, 'let updated = Array.isArray(prev) ? [...prev] : [];');
u = u.replace(/const safe = Array\.isArray\(prev\) \? prev : \[\];\n\s*if \(!safe\.find/g, 'const safe = Array.isArray(prev) ? prev : [];\n      if (safe.findIndex(m => m.pubkey === memberPubkey) === -1) {');
u = u.replace(/if \(!updated\.find/g, 'if (updated.findIndex');
u = u.replace(/if \(!prev\.find/g, 'if (prev.findIndex');
u = u.replace(/if \(!m\.find/g, 'if (m.findIndex');
fs.writeFileSync('src/hooks/useNIP29Group.js', u);

console.log('✓ Fixed array crash safely');
