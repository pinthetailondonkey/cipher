"""Resolve a package.json runner-line conflict by UNION, never by picking a side.

Why: the launch line (HEAD) and the replayed commit both edit the single long
`"test"` string. HEAD carries entries added after the replayed commit's base;
the commit carries entries HEAD never had (two suites that exist in the tree and
were never on the line). Taking either side alone silently drops test files from
the runner, and a dropped file does not fail -- it goes quiet.

Order: HEAD's paths first, then any path only the other side names, so the
launch line's ordering is preserved byte for byte up to the inserted entries.
"""
import json
import re
import sys

path = sys.argv[1]
text = open(path).read()

start = text.index('<<<<<<< HEAD')
mid = text.index('=======', start)
end = text.index('>>>>>>>', mid)

ours_block = text[start:mid]
theirs_block = text[mid:end]


def test_line(block):
    for line in block.split('\n'):
        if '"test": "node --import' in line:
            return line.strip().lstrip('+ ').rstrip(',')
    return None


ours_line = test_line(ours_block)
theirs_line = test_line(theirs_block)
if not ours_line or not theirs_line:
    sys.exit('resolve: could not find one test line on each side')


def paths(line):
    return line.split('--test ', 1)[1].rstrip('",').split()


ours, theirs = paths(ours_line), paths(theirs_line)
union = list(ours) + [p for p in theirs if p not in set(ours)]

rebuilt = ours_line.split('--test ', 1)[0] + '--test ' + ' '.join(union) + '",'

# Replace the whole conflicted region with the one rebuilt line, keeping the
# indentation the surrounding file uses.
indent = re.match(r'\s*', ours_block.split('\n')[1] if len(ours_block.split('\n')) > 1 else '')
lead = '    '
resolved = text[:start] + lead + rebuilt + '\n' + text[end:].split('\n', 1)[1]
open(path, 'w').write(resolved)

json.loads(resolved)  # refuse to write a package.json that does not parse
print(f'union paths={len(union)} head={len(ours)} theirs={len(theirs)} '
      f'added={[p for p in theirs if p not in set(ours)]}')
