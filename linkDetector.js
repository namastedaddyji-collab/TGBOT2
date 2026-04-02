export function containsTelegramLink(text = "") {
  if (!text) return false;

  const cleaned = text.toLowerCase();

  return (
    cleaned.includes("t.me/") ||
    cleaned.includes("telegram.me/") ||
    cleaned.includes("tg://") ||
    /t\s*\.?\s*me\//i.test(text) // catches spaced bypass like "t . me"
  );
}
