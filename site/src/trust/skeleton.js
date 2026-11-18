// Name "skeletons" for the copy check: two names that LOOK the same get the same skeleton.
//
//   skeleton('U⁠S⁠DG') === skeleton('$usdg') === skeleton('ＵＳＤＧ') === skeleton('USDG') === 'usdg'
//
// Used by the launch indexer (api/, stored as sym_skel / name_skel) and by the copy check (api/src/copies.js),
// so both sides must always call this one function. Pure: no network, no DOM. Runs in browsers, Workers and jsc.
//
// Steps:
//   1. Remove hidden format characters (zero-width spaces and joiners, direction marks, word joiner and the
//      invisible operators U+2060-U+206F, BOM, soft hyphen, combining grapheme joiner, variation selectors,
//      tag characters, Hangul fillers and every other Unicode "default ignorable" code point).
//   2. Unicode NFKC: fullwidth (ＵＳＤＧ), math letters (𝐔𝐒𝐃𝐆), circled/superscript forms become plain letters.
//   3. Capital Greek/Cyrillic look-alikes -> Latin (Η looks like H, but its small form η looks like n, so
//      capitals are mapped before lower-casing).
//   4. Lower-case, then strip accents (NFD, drop combining marks): é -> e.
//   5. Small Greek/Cyrillic/Armenian look-alikes, small capitals and stroked letters (ø, ł) -> Latin, plus
//      every other character Unicode's confusables data says looks like one Latin letter or digit (the
//      *_PAIRS tables below; a few run before step 2 because NFKC would change them).
//   6. Keep only letters and digits: '$', spaces, punctuation, symbols and emoji are dropped.
//
// Digits are NOT folded into letters (0 stays 0, 1 stays 1): 'USD0' and 'USDO' are different skeletons.
// Digit/letter swaps are found by nearKeys() below instead, as "near" matches.

// Hidden characters (step 1). The \p{Default_Ignorable_Code_Point} class covers all of the listed ranges and
// more; the explicit list documents the ones fake tickers use.
const HIDDEN = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ\u{1D173}-\u{1D17A}\u{E0000}-\u{E0FFF}]|\p{Default_Ignorable_Code_Point}/gu;

// Step 3: capitals whose small form looks different.
const UPPER = {
  // Greek
  'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o',
  'Ρ': 'p', 'Τ': 't', 'Χ': 'x', 'Υ': 'y', 'Ϳ': 'j',
  // Cyrillic
  'А': 'a', 'В': 'b', 'Е': 'e', 'Ё': 'e', 'З': '3', 'Н': 'h', 'І': 'i', 'Ї': 'i', 'Ј': 'j', 'К': 'k',
  'М': 'm', 'О': 'o', 'Р': 'p', 'С': 'c', 'Ѕ': 's', 'Т': 't', 'У': 'y', 'Х': 'x', 'Ү': 'y', 'Һ': 'h',
  'Ԁ': 'd', 'Ԛ': 'q', 'Ԝ': 'w', 'Ӏ': 'i', 'Ь': 'b',
};

// Step 5: small letters (after lower-casing and accent stripping).
const LOWER = {
  // Cyrillic
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'һ': 'h', 'н': 'h', 'і': 'i', 'ї': 'i', 'ј': 'j', 'к': 'k',
  'м': 'm', 'о': 'o', 'р': 'p', 'с': 'c', 'ѕ': 's', 'т': 't', 'у': 'y', 'ү': 'y', 'х': 'x', 'ԁ': 'd',
  'ԛ': 'q', 'ԝ': 'w', 'ӏ': 'i', 'ь': 'b', 'ɡ': 'g',
  // Greek
  'α': 'a', 'β': 'b', 'ε': 'e', 'ζ': 'z', 'η': 'n', 'ι': 'i', 'κ': 'k', 'μ': 'u', 'ν': 'v', 'ο': 'o',
  'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'γ': 'y', 'ϳ': 'j',
  // Armenian
  'օ': 'o', 'ս': 'u', 'ո': 'n', 'հ': 'h', 'զ': 'q', 'ց': 'g',
  // Latin extras and small capitals
  'ı': 'i', 'ȷ': 'j', 'ɑ': 'a', 'ɩ': 'i', 'ʟ': 'l', 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e',
  'ɢ': 'g', 'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r',
  'ꜱ': 's', 'ᴛ': 't', 'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z', 'ø': 'o', 'ł': 'l', 'đ': 'd',
  'ħ': 'h', 'ŧ': 't', 'ƀ': 'b', 'ɨ': 'i', 'ʉ': 'u', 'ɇ': 'e', 'ɍ': 'r', 'ɏ': 'y', 'ƶ': 'z', 'ǥ': 'g',
};

// The rest of Unicode's confusables data with a one-letter (or one-digit) Latin look-alike: Cherokee, Lisu,
// Coptic, Canadian syllabics, Armenian/Georgian/Hebrew/Arabic shapes, Indic digits, more Cyrillic/Greek
// (г looks like r, ш like w, σ like o) and others. Generated once from the Unicode confusables data (ICU's
// spoof checker on macOS), as pairs: each look-alike character followed by its Latin letter or digit.
// Shapes of capital I / l / 1 map to i (or 1 for digits); nearKeys() still finds the l and 1 spellings.
// PRE_PAIRS run before NFKC (NFKC would turn lunate Ϲ into Σ, and σ looks like o but ϲ like c);
// UPPER_PAIRS are capitals whose small form looks different; LOWER_PAIRS run with LOWER (step 5).
const PRE_PAIRS = 'σoϹc𝛔o𝜎o𝝈o𝞂o𝞼o';
const UPPER_PAIRS = 'ƄbƧ2Ʒ3Ƽ5Ȝ3Ȣ8ϜfϨ2Ϭ6ϺmѴvӠ3ԌgՏsᎠdᎡrᎢtᎥiᎩyᎪaᎫjᎬeᎳwᎷmᎻhᎽyᏀgᏂhᏃzᏎ4ᏏbᏒrᏔwᏕsᏙvᏚsᏞlᏟcᏢpᏦkᏧdᏮ6ᏳgᏴbⲂbⲎhⲒiⲔk'
  + 'ⲘmⲚnⲜ3ⲞoⲢpⲤcⲦtⲨyⲬxⳄ3Ⳋ9Ⳍ3ⳎpⳐlⳒ6Ⳝ6Ꙅ2Ꝛ2Ꝫ3Ꝯ9ꞘfꞫ3ꞲjꞳxꞴb𐐄o𐐕c𐐛i𐐠s𐒴r𐓂o𐓎u𐓒7𑢠v𑢢f𑢣i𑢤y𑢦e𑢩z𑢬9𑢮e𑢯4𑢲i𑢵o𑢸u𑢻5𑢼t';
const LOWER_PAIRS = 'þpƍgƒfƽsƿpǀiȣ8ɣyɯwʋuςcϝfϭoϸpб6гrшwѡwѵvҽeաwգqռnւiքf\u{5D5}i\u{5D8}v\u{5DF}i\u{5E1}o\u{627}i'
  + '\u{647}o\u{661}1\u{665}o\u{667}v\u{6BE}o\u{6C1}o\u{6D5}o\u{6F1}1\u{6F5}o\u{6F7}v\u{7C0}0\u{7CA}i'
  + '०0३3০0৪8৭9੦0੧9੪8૦0૩3ଠo୦0୨9௦0౦0೦0ടsഠo൦0൭9๐0໐0ငcဝo၀0ၚcყyჿoሀuዐoᐯvᑌuᑭpᑯdᑲbᒍjᒪlᒿ2ᕁxᕼhᕽxᖇrᖯbᖴfᗅaᗞdᗪdᗰm'
  + 'ᗷbᚷxᛁiᛕkᛖm០0ᴑoᴦrᶃgᶌyẝfỿyⲅrⲓiⲟoⲣpⲥcⲩyⲽwⳋ9ⳏpⳓ6ⴸvⴹeⵏiⵔoⵕqⵝx〇oꓐbꓑpꓒdꓓdꓔtꓖgꓗkꓙjꓚcꓜzꓝfꓟmꓠnꓡlꓢsꓣrꓦvꓧhꓪw'
  + 'ꓫxꓬyꓮaꓰeꓲiꓳoꓴuꙇiꛟvꛯ2ꞙfꞟuꬲeꬵfꬽoꭇrꭈrꭎuꭒuꭚyꭵiꮁrꮃwꮓzꮩvꮪsꮯc𐊂b𐊆e𐊇f𐊊i𐊐x𐊒o𐊕p𐊖s𐊗t𐊠a𐊡b𐊢c𐊥f𐊫o𐊰m𐊱t𐊲y𐊴x𐋏h𐋵z𐌁b'
  + '𐌂c𐌉i𐌑m𐌕t𐌗x𐌚8𐌠i𐌢x𐐬o𐐽c𐑈s𐓪o𐓶u𐔓n𐔖o𐔘k𐔜c𐔝v𐔥f𐔦i𐔧x𑓐0𑜆v𑜊w𑜎w𑜏w𑣀v𑣁s𑣂f𑣃i𑣄z𑣆7𑣈o𑣊3𑣌9𑣕6𑣖9𑣗o𑣘u𑣜y𑣠0𑣥z𑣦w𑣩c𑣬x𑣯w𑣲c𖼈v'
  + '𖼊t𖼖i𖼨i𖼵r𖼺s𖼻3𖽀a𖽂u𖽃y\u{1E8C7}i\u{1E8CB}8';
function addPairs(table, pairs) {
  const cps = [...pairs];
  for (let i = 0; i + 1 < cps.length; i += 2) if (!Object.prototype.hasOwnProperty.call(table, cps[i])) table[cps[i]] = cps[i + 1];
  return table;
}
const PRE = addPairs({}, PRE_PAIRS);
addPairs(UPPER, UPPER_PAIRS);
addPairs(LOWER, LOWER_PAIRS);

const MARKS = /\p{M}/gu;
const NOT_ALNUM = /[^\p{L}\p{N}]/gu;

function mapChars(s, table) {
  let out = '';
  for (const ch of s) out += Object.prototype.hasOwnProperty.call(table, ch) ? table[ch] : ch;
  return out;
}

export function skeleton(str) {
  if (str == null) return '';
  let s = mapChars(String(str).replace(HIDDEN, ''), PRE);
  s = s.normalize('NFKC').replace(HIDDEN, '');
  s = mapChars(s, UPPER);
  s = s.toLowerCase().normalize('NFD').replace(MARKS, '').normalize('NFC');
  s = mapChars(s, LOWER);
  return s.replace(NOT_ALNUM, '');
}

// True when one character is hidden (step 1) or an unusual space; used by the display helpers in rules.js.
export function isHiddenChar(ch) {
  HIDDEN.lastIndex = 0;
  if (HIDDEN.test(ch)) { HIDDEN.lastIndex = 0; return true; }
  HIDDEN.lastIndex = 0;
  return /\p{Zs}/u.test(ch) && ch !== ' ';
}

// True when one character only looks like a plain Latin letter or digit: a Greek/Cyrillic/other-script
// look-alike, a fullwidth or math letter, or a small capital. Accented Latin letters (é) are not marked.
export function isLookalikeChar(ch) {
  if (/^[\x00-\x7F]$/.test(ch) || isHiddenChar(ch)) return false;
  const sk = skeleton(ch);
  if (!/^[a-z0-9]+$/.test(sk)) return false;
  if ([PRE, UPPER, LOWER].some((t) => Object.prototype.hasOwnProperty.call(t, ch))) return true;
  if (ch.normalize('NFKC') !== ch) return true;                 // fullwidth, math alphanumerics, ligatures
  return !/\p{Script=Latin}/u.test(ch);
}

// ---- near-match keys ---------------------------------------------------------------------------------
// One-step swaps between characters that look alike in a skeleton (both directions are generated).
export const NEAR_SWAPS = [
  ['0', 'o'], ['1', 'l'], ['1', 'i'], ['l', 'i'], ['5', 's'], ['8', 'b'], ['3', 'e'], ['4', 'a'],
  ['7', 't'], ['2', 'z'], ['6', 'g'], ['9', 'g'], ['rn', 'm'], ['vv', 'w'], ['cl', 'd'], ['u', 'v'],
];

// Keys for "near" matches of a skeleton: each with ONE character deleted (only for skeletons of 4+ characters,
// so a key never gets shorter than 3), and each with ONE look-alike swapped. '$' and spaces are already gone
// from skeletons, so "with or without $" needs no extra key. The skeleton itself is not included.
export function nearKeys(skel, { maxKeys = 60 } = {}) {
  const s = String(skel || '');
  const out = new Set();
  if (s.length >= 4) {
    for (let i = 0; i < s.length; i++) out.add(s.slice(0, i) + s.slice(i + 1));
  }
  for (const [a, b] of NEAR_SWAPS) {
    for (const [from, to] of [[a, b], [b, a]]) {
      let i = s.indexOf(from);
      while (i !== -1) {
        out.add(s.slice(0, i) + to + s.slice(i + from.length));
        i = s.indexOf(from, i + 1);
      }
    }
  }
  out.delete(s);
  out.delete('');
  return [...out].slice(0, maxKeys);
}
