/** Same rules as public.normalize_attendance_name() in the database. */
export function normalizeName(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[-_/]+/g, " ")
    .replace(/[.,'’‘"“”`´()]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `short` could be an abbreviation of `long`: "budi s" ~ "budi santoso", "budi" ~ "budi santoso". */
function isAbbreviationOf(short, long) {
  if (short.length > long.length || short.length === 0) return false;
  if (short[0] !== long[0]) return false;
  // A single letter may stand for a word ("s" = "santoso"); digits never count as initials.
  return short.every((word, index) => word === long[index] || (/^\p{L}$/u.test(word) && long[index].startsWith(word)));
}

/**
 * Flags records that may belong to the same person within one meeting. The
 * database already rejects exact duplicates (same normalized name + program); this
 * only surfaces near-duplicates for an admin to review. Returns Map<id, reason>.
 */
export function findPossibleDuplicates(entries) {
  const flags = new Map();
  const byMeeting = new Map();
  for (const entry of entries) {
    const words = normalizeName(entry.full_name).split(" ").filter(Boolean);
    if (!words.length) continue;
    const list = byMeeting.get(entry.meeting_id) || [];
    list.push({ entry, words, key: words.join(" ") });
    byMeeting.set(entry.meeting_id, list);
  }
  const flag = (entry, reason) => {
    if (!flags.has(entry.id)) flags.set(entry.id, reason);
  };
  for (const list of byMeeting.values()) {
    const byFirstWord = new Map();
    for (const item of list) {
      const group = byFirstWord.get(item.words[0]) || [];
      group.push(item);
      byFirstWord.set(item.words[0], group);
    }
    for (const group of byFirstWord.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i];
          const b = group[j];
          if (a.key === b.key) {
            if (a.entry.study_program_id !== b.entry.study_program_id) {
              flag(a.entry, "Nama sama tercatat di program studi lain");
              flag(b.entry, "Nama sama tercatat di program studi lain");
            }
            continue;
          }
          // Either name may be the abbreviated one, even with the same word count.
          if (isAbbreviationOf(a.words, b.words) || isAbbreviationOf(b.words, a.words)) {
            flag(a.entry, `Mirip dengan “${b.entry.full_name}”`);
            flag(b.entry, `Mirip dengan “${a.entry.full_name}”`);
          }
        }
      }
    }
  }
  return flags;
}
