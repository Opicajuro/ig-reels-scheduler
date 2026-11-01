// The emoji a caption line can carry, by a word spoken in it.
const EMOJI_BY_WORD = {
  "💰": ["money", "cash", "dollar", "dollars", "rich", "paid", "pay", "price", "million", "millions"],
  "🔥": ["fire", "hot", "lit", "burn", "burning"],
  "❤️": ["love", "loved", "loves", "loving", "heart"],
  "😂": ["laugh", "laughing", "laughed", "funny", "lol", "haha", "joke", "hilarious"],
  "🤯": ["wow", "crazy", "insane", "unbelievable", "shocking"],
  "🏆": ["win", "winner", "winning", "won", "champion"],
  "💡": ["idea", "ideas", "tip", "tips", "secret", "trick"],
  "🚀": ["growth", "grow", "launch", "rocket"],
  "💪": ["strong", "strength", "gym", "workout", "power"],
  "🎉": ["party", "celebrate", "congrats", "birthday"],
  "😢": ["sad", "cry", "crying", "tears"],
  "🎵": ["music", "song", "sing", "dance"],
  "🍔": ["food", "eat", "eating", "hungry", "burger"],
  "🎯": ["goal", "goals", "target", "focus"],
  "⏰": ["time", "late", "deadline", "hurry"],
  "😎": ["cool", "awesome", "amazing"],
};

const EMOJI = new Map(Object.entries(EMOJI_BY_WORD).flatMap(([emoji, words]) => words.map((word) => [word, emoji])));

// The emoji for the first word of the line that has one, or null. Case and punctuation around a word do not count.
export function lineEmoji(words) {
  for (const word of words) {
    const emoji = EMOJI.get(word.toLowerCase().replace(/[^a-z]/g, ""));
    if (emoji) return emoji;
  }
  return null;
}
