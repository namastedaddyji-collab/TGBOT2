import { Bot, InlineKeyboard, type Context } from "grammy";
import { containsTelegramLink } from "./linkDetector.js";
import {
  upsertUser, upsertGroup, getGroupSettings, incrementWarning, resetWarning,
  logActivity, saveMessageMap, getMessageMap, adjustReputation,
  getUserIdsByType, saveBroadcastHistory, ensureBotSettings,
  db, groupsTable, groupSettingsTable, usersTable, warningsTable, botSettingsTable,
} from "./db.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const BOT_TOKEN = process.env["BOT_TOKEN"];
const OWNER_ID = process.env["BOT_OWNER_ID"] || "";
const LOGS_CHAT_ID = process.env["LOGS_CHAT_ID"] || "";
const BOT_USERNAME = "@BioBan_Robot";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

export const bot = new Bot(BOT_TOKEN as string);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isOwner(userId: number | string): boolean {
  return userId.toString() === OWNER_ID;
}

async function isAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.from || !ctx.chat) return false;
  if (isOwner(ctx.from.id)) return true;
  try {
    const m = await ctx.getChatMember(ctx.from.id);
    return m.status === "administrator" || m.status === "creator";
  } catch {
    return false;
  }
}

async function sendLog(text: string, extra?: object) {
  if (!LOGS_CHAT_ID) return;
  try {
    return await bot.api.sendMessage(LOGS_CHAT_ID, text, { parse_mode: "HTML", ...extra });
  } catch (e) {
    logger.error({ err: e }, "Log send failed");
  }
}

async function getUserBio(userId: number): Promise<string | null> {
  try {
    const chat = await bot.api.getChat(userId);
    return (chat as any).bio ?? null;
  } catch {
    return null;
  }
}

function mention(user: { id: number; first_name: string; username?: string }): string {
  return `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Safe edit: tries editMessageText, falls back to reply
async function safeEdit(ctx: Context, text: string, opts: object = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML" as const, ...opts });
  } catch {
    try {
      await ctx.reply(text, { parse_mode: "HTML" as const, ...opts });
    } catch {}
  }
}

// Safe answerCallbackQuery — always call this first to prevent "query expired" errors
async function ack(ctx: Context, text?: string) {
  try {
    await ctx.answerCallbackQuery(text ?? "");
  } catch {}
}

// ─── Mute / Unmute ────────────────────────────────────────────────────────────

async function muteUser(chatId: number, userId: number) {
  await bot.api.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false, can_send_audios: false, can_send_documents: false,
      can_send_photos: false, can_send_videos: false, can_send_video_notes: false,
      can_send_voice_notes: false, can_send_polls: false, can_send_other_messages: false,
      can_add_web_page_previews: false, can_change_info: false,
      can_invite_users: false, can_pin_messages: false,
    },
  });
}

async function unmuteUser(chatId: number, userId: number) {
  await bot.api.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: true, can_send_audios: true, can_send_documents: true,
      can_send_photos: true, can_send_videos: true, can_send_video_notes: true,
      can_send_voice_notes: true, can_send_polls: true, can_send_other_messages: true,
      can_add_web_page_previews: true, can_change_info: false,
      can_invite_users: false, can_pin_messages: false,
    },
  });
}

// ─── Punishment ───────────────────────────────────────────────────────────────

async function applyPunishment(
  ctx: Context,
  target: { id: number; first_name: string; username?: string },
  punishment: string,
  warnCount: number,
  maxWarns: number,
  groupId: string,
  reason: "bio_link" | "backup_group" = "bio_link"
) {
  const chatId = ctx.chat!.id;
  let actionDone = "";

  try {
    if (punishment === "mute") {
      await muteUser(chatId, target.id);
      actionDone = "muted";
    } else if (punishment === "ban") {
      await ctx.api.banChatMember(chatId, target.id);
      actionDone = "banned";
    } else if (punishment === "kick") {
      await ctx.api.banChatMember(chatId, target.id);
      await ctx.api.unbanChatMember(chatId, target.id);
      actionDone = "kicked";
    }
  } catch (e) {
    logger.error({ err: e }, "Punishment failed");
    return;
  }

  await adjustReputation(target.id.toString(), -20);
  await logActivity({
    type: actionDone,
    details: `${reason === "bio_link" ? "Bio link" : "Backup group"} — warnings: ${warnCount}/${maxWarns}`,
    userId: target.id.toString(),
    groupId,
  });

  const reasonText = reason === "bio_link"
    ? "Telegram invite link found in bio."
    : "Repeated messages without joining the required backup group.";

  const botMe = await bot.api.getMe();
  const keyboard =
    punishment !== "kick"
      ? new InlineKeyboard().url(
          `👉 ${actionDone === "banned" ? "Get Unbanned" : "Unmute Me"}`,
          `https://t.me/${botMe.username}?start=unmute_${chatId}`
        )
      : undefined;

  const punishMsg = await ctx.reply(
    `🔇 ${mention(target)} has been <b>${actionDone}</b>!\n\n` +
    `❌ <b>Reason:</b> ${reasonText}\n` +
    (punishment !== "kick"
      ? `\n${reason === "bio_link" ? "Remove the link from your bio" : "Join the required group"}, then tap below to get ${actionDone === "banned" ? "unbanned" : "unmuted"}:`
      : `\nFix the issue before rejoining.`),
    { parse_mode: "HTML", reply_markup: keyboard }
  );

  const logMsg = await sendLog(
    `🔇 <b>${actionDone.toUpperCase()}</b>\n\n` +
    `👤 ${mention(target)} (<code>${target.id}</code>)\n` +
    `🏠 Group: <b>${ctx.chat?.title}</b> (<code>${chatId}</code>)\n` +
    `⚠️ Warnings: ${warnCount}/${maxWarns}\n` +
    `📌 Reason: ${reasonText}`
  );
  if (logMsg) await saveMessageMap(logMsg.message_id.toString(), target.id.toString());

  if (punishment === "kick") {
    setTimeout(() => ctx.api.deleteMessage(chatId, punishMsg.message_id).catch(() => {}), 90000);
  }
}

// ─── Unmute flow ──────────────────────────────────────────────────────────────

async function handleUnmuteFlow(ctx: Context, groupId: string) {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  const bio = await getUserBio(userId);

  if (bio && containsTelegramLink(bio)) {
    const keyboard = new InlineKeyboard().text("✅ I removed it — Check again", `recheck_bio_${groupId}`);
    const msg =
      `🚫 <b>Your bio still has a Telegram link!</b>\n\n` +
      `📱 <b>Steps to fix:</b>\n` +
      `1. Open Telegram Settings\n` +
      `2. Tap <b>Edit Profile</b>\n` +
      `3. Clear your <b>Bio</b>\n` +
      `4. Come back and tap the button below`;
    await safeEdit(ctx, msg, { reply_markup: keyboard });
    return;
  }

  // Bio is clean — check membership status and unmute/unban
  const groupIdNum = Number(groupId);
  let memberStatus = "unknown";
  try {
    const member = await bot.api.getChatMember(groupIdNum, userId);
    memberStatus = member.status;
  } catch (e) {
    logger.error({ err: e }, "getChatMember failed in unmute flow");
    await safeEdit(ctx,
      `⚠️ Couldn't verify your membership in the group. Please ask an admin to unmute you manually.`,
      {}
    );
    return;
  }

  if (memberStatus === "restricted") {
    try {
      await unmuteUser(groupIdNum, userId);
    } catch (e) {
      logger.error({ err: e }, "unmuteUser failed");
      await safeEdit(ctx,
        `⚠️ Your bio is clean but I couldn't unmute you — the bot may have lost admin rights. Ask an admin.`,
        {}
      );
      return;
    }
  } else if (memberStatus === "kicked") {
    try {
      await bot.api.unbanChatMember(groupIdNum, userId);
    } catch (e) {
      logger.error({ err: e }, "unbanChatMember failed");
      await safeEdit(ctx, `⚠️ Bio is clean but couldn't unban you. Ask an admin.`, {});
      return;
    }
  }
  // If status is "member", "administrator", "creator" — already active, just reset warnings

  await adjustReputation(userId.toString(), 10);
  await resetWarning(userId.toString(), groupId);
  await logActivity({
    type: "unmute",
    details: "User cleaned bio and was unmuted via button",
    userId: userId.toString(),
    groupId,
  });

  await safeEdit(ctx,
    `✅ <b>You're all clear!</b>\n\nYour bio is clean. Welcome back! 🥂\n\n<i>Reputation +10 • Warnings reset</i>`,
    {}
  );
}

// ─── Settings Menu Builders ───────────────────────────────────────────────────

async function buildMainSettingsMenu(groupId: string, groupTitle: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  if (!s) throw new Error("No settings");

  const text =
    `⚙️ <b>Settings — ${groupTitle}</b>\n\n` +
    `Tap any button to view details and change.\n\n` +
    `⚠️ <b>Warnings</b> — Strikes before punishment (current: <b>${s.maxWarnings}</b>)\n` +
    `⚖️ <b>Punishment</b> — Action at max strikes (current: <b>${s.punishment.toUpperCase()}</b>)\n` +
    `🤫 <b>Silent Mode</b> — DM warnings only, no group noise (current: <b>${s.silentMode ? "ON" : "OFF"}</b>)\n` +
    `🛡 <b>Anti-Bypass</b> — Catches disguised links like "t . me" (current: <b>${s.antiBypassing ? "ON" : "OFF"}</b>)\n` +
    `📦 <b>Backup Group</b> — Members-only gate + archive (current: <b>${s.backupChannel ?? "Not set"}</b>)`;

  const keyboard = new InlineKeyboard()
    .text("⚠️ Warnings", `menu_warn_${groupId}`)
    .text("⚖️ Punishment", `menu_punish_${groupId}`).row()
    .text(`🤫 Silent ${s.silentMode ? "✅" : "❌"}`, `menu_silent_${groupId}`)
    .text(`🛡 Anti-Bypass ${s.antiBypassing ? "✅" : "❌"}`, `menu_antibypass_${groupId}`).row()
    .text("📦 Backup Group", `menu_backup_${groupId}`)
    .text("📊 Stats", `menu_stats_${groupId}`).row()
    .text("🏆 Leaderboard", `menu_leaderboard_${groupId}`)
    .text("❌ Close", "close_menu");

  return { text, keyboard };
}

async function buildWarnMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  const cur = s?.maxWarnings ?? 3;
  const text =
    `⚠️ <b>Warning Threshold</b>\n\n` +
    `How many strikes before action is taken?\n` +
    `Current: <b>${cur}</b>\n\n` +
    `📌 Strike 1 — Message deleted + ⌛ (silent)\n` +
    `📌 Strike 2 — Warning message sent\n` +
    `📌 Strike ${cur} — User is <b>${s?.punishment ?? "muted"}</b>`;

  const keyboard = new InlineKeyboard()
    .text(cur === 1 ? "1️⃣ ✓" : "1️⃣", `setwarn_${groupId}_1`)
    .text(cur === 2 ? "2️⃣ ✓" : "2️⃣", `setwarn_${groupId}_2`)
    .text(cur === 3 ? "3️⃣ ✓" : "3️⃣", `setwarn_${groupId}_3`).row()
    .text("« Back", `menu_main_${groupId}`);

  return { text, keyboard };
}

async function buildPunishMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  const cur = s?.punishment ?? "mute";
  const text =
    `⚖️ <b>Punishment Type</b>\n\n` +
    `What happens when max warnings are hit?\n\n` +
    `🔇 <b>Mute</b> — Silenced until they fix the issue and tap Unmute\n` +
    `🚫 <b>Ban</b> — Banned until they fix the issue and tap Unban\n` +
    `👟 <b>Kick</b> — Removed (can rejoin after fixing)\n\n` +
    `Current: <b>${cur.toUpperCase()}</b>`;

  const keyboard = new InlineKeyboard()
    .text(cur === "mute" ? "🔇 Mute ✓" : "🔇 Mute", `setpunish_${groupId}_mute`)
    .text(cur === "ban" ? "🚫 Ban ✓" : "🚫 Ban", `setpunish_${groupId}_ban`)
    .text(cur === "kick" ? "👟 Kick ✓" : "👟 Kick", `setpunish_${groupId}_kick`).row()
    .text("« Back", `menu_main_${groupId}`);

  return { text, keyboard };
}

async function buildSilentMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  const enabled = s?.silentMode ?? false;
  const text =
    `🤫 <b>Silent Mode</b>\n\n` +
    `Controls whether ${BOT_USERNAME} posts visible warning messages in the group.\n\n` +
    `<b>When OFF (default):</b>\n` +
    `The bot posts a public warning like:\n` +
    `<i>"⚠️ @user — Warning 1/3. Your bio has a link!"</i>\n` +
    `Visible to everyone.\n\n` +
    `<b>When ON:</b>\n` +
    `Bot silently deletes the message and DMs the user. No group noise.\n\n` +
    `<b>Current:</b> ${enabled ? "✅ Silent — warnings go to DM" : "❌ Off — warnings posted in group"}`;

  const keyboard = new InlineKeyboard()
    .text(enabled ? "Turn OFF ❌" : "Turn ON ✅", `toggle_silent_${groupId}`).row()
    .text("« Back", `menu_main_${groupId}`);

  return { text, keyboard };
}

async function buildAntiBypassMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  const enabled = s?.antiBypassing ?? true;
  const text =
    `🛡 <b>Anti-Bypass Detection</b>\n\n` +
    `Catches obfuscated invite links that evade basic filters.\n\n` +
    `<b>Examples caught:</b>\n` +
    `• <code>t . me / groupname</code> (spaces)\n` +
    `• <code>tеlеgram.me</code> (Cyrillic lookalike chars)\n` +
    `• <code>t·me/link</code> (dots replaced with ·)\n\n` +
    `<b>Current:</b> ${enabled ? "✅ ON — All tricks are caught" : "❌ OFF — Only plain links detected"}`;

  const keyboard = new InlineKeyboard()
    .text(enabled ? "Turn OFF ❌" : "Turn ON ✅", `toggle_antibypass_${groupId}`).row()
    .text("« Back", `menu_main_${groupId}`);

  return { text, keyboard };
}

async function buildBackupMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const s = await getGroupSettings(groupId);
  const ch = s?.backupChannel ?? null;
  const text =
    `📦 <b>Backup Group / Channel</b>\n\n` +
    `Setting a backup group/channel activates two independent checks:\n\n` +
    `<b>1️⃣ Members-only gate (with warnings)</b>\n` +
    `Every message is checked: is this user a member?\n` +
    `• Strike 1 — Message deleted + ⌛ join button (silent)\n` +
    `• Strike 2 — Warning message sent\n` +
    `• Strike 3 — User is muted/banned\n\n` +
    `<b>2️⃣ Message archive</b>\n` +
    `Messages deleted for bio link violations are forwarded there as evidence.\n\n` +
    `<b>Current:</b> ${ch ? `<code>${ch}</code>` : "⚠️ Not set"}\n\n` +
    `Set with: <code>/setbackup @groupOrChannel</code>\n` +
    `Remove with: <code>/setbackup off</code>`;

  const keyboard = new InlineKeyboard().text("« Back", `menu_main_${groupId}`);
  return { text, keyboard };
}

async function buildStatsMenu(groupId: string): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const warns = await db.select().from(warningsTable).where(eq(warningsTable.groupId, groupId));
  const s = await getGroupSettings(groupId);
  const totalWarns = warns.reduce((sum, w) => sum + w.count, 0);
  const uniqueViolators = new Set(warns.map((w) => w.userId)).size;
  const text =
    `📊 <b>Group Statistics</b>\n\n` +
    `⚠️ Total warnings given: <b>${totalWarns}</b>\n` +
    `👤 Unique violators: <b>${uniqueViolators}</b>\n` +
    `⚙️ Punishment: <b>${s?.punishment?.toUpperCase()}</b>\n` +
    `🔢 Max warnings: <b>${s?.maxWarnings}</b>`;

  const keyboard = new InlineKeyboard().text("« Back", `menu_main_${groupId}`);
  return { text, keyboard };
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  const from = ctx.from!;
  await upsertUser({ id: from.id.toString(), firstName: from.first_name, username: from.username, type: "user" });

  const payload = ctx.match?.trim();

  // Unmute deep-link
  if (payload?.startsWith("unmute_")) {
    const groupId = payload.replace("unmute_", "");
    const keyboard = new InlineKeyboard().text("🔍 Check My Bio Now", `recheck_bio_${groupId}`);
    await ctx.reply(
      `👋 <b>Hey ${from.first_name}!</b>\n\n` +
      `To get unmuted, follow these steps:\n\n` +
      `1️⃣ Open <b>Telegram Settings</b>\n` +
      `2️⃣ Tap <b>Edit Profile</b>\n` +
      `3️⃣ Remove any <b>invite links</b> from your Bio\n` +
      `4️⃣ Tap the button below to verify\n\n` +
      `<i>Once your bio is clean, you'll be unmuted instantly.</i>`,
      { parse_mode: "HTML", reply_markup: keyboard }
    );
    return;
  }

  // Owner panel
  if (isOwner(from.id)) {
    const [totalGroups, totalUsers] = await Promise.all([
      db.select().from(groupsTable).then((r) => r.filter((g) => g.isActive).length),
      db.select().from(usersTable).then((r) => r.length),
    ]);
    const ownerKeyboard = new InlineKeyboard()
      .text("📢 Broadcast", "owner_broadcast_menu")
      .text("📊 Stats", "owner_stats").row()
      .text("⚙️ Bot Settings", "owner_settings")
      .text("📋 Commands", "show_commands");
    await ctx.reply(
      `🥂 <b>${BOT_USERNAME} — Owner Panel</b>\n\n` +
      `📊 <b>Live Stats:</b>\n├ 🏠 Groups: <b>${totalGroups}</b>\n└ 👥 Users: <b>${totalUsers}</b>`,
      { parse_mode: "HTML", reply_markup: ownerKeyboard }
    );
    return;
  }

  // Regular user start
  const botMe = await bot.api.getMe();
  const keyboard = new InlineKeyboard()
    .url("➕ Add to My Group", `https://t.me/${botMe.username}?startgroup=true`).row()
    .text("ℹ️ How It Works", "how_it_works")
    .text("📋 Commands", "show_commands").row()
    .text("👨‍💻 Support", "contact_support");

  await ctx.reply(
    `👋 <b>Welcome to ${BOT_USERNAME}!</b>\n\n` +
    `🛡 I protect Telegram groups from users who have <b>invite links in their bios</b>.\n\n` +
    `<b>✅ What I do:</b>\n` +
    `• Detect bio links (even disguised ones)\n` +
    `• Warn users automatically (3 strikes)\n` +
    `• Mute / Ban / Kick at your choice\n` +
    `• Enforce backup group membership\n` +
    `• Let users self-unmute after fixing their bio\n\n` +
    `<b>🚀 Get started:</b>\n` +
    `1. Add me to your group\n` +
    `2. Make me <b>admin</b> with Restrict + Delete + Ban permissions\n` +
    `3. I'll protect your group automatically!\n\n` +
    `<i>Use /settings in your group to configure everything.</i>`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
});

// ─── /settings ────────────────────────────────────────────────────────────────

bot.command(["settings", "menu"], async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) {
    const m = await ctx.reply("❌ Admin only.");
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 4000);
    return;
  }
  try { await ctx.deleteMessage(); } catch {}
  await upsertGroup({ id: ctx.chat.id.toString(), title: ctx.chat.title, isActive: true });
  const { text, keyboard } = await buildMainSettingsMenu(ctx.chat.id.toString(), ctx.chat.title);
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: keyboard });
});

// ─── /warn /unwarn /warns ─────────────────────────────────────────────────────

bot.command("warn", async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const target = ctx.message?.reply_to_message?.from;
  if (!target || target.is_bot) {
    const m = await ctx.reply("⚠️ Reply to a user's message to warn them.");
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
    return;
  }
  const s = await getGroupSettings(ctx.chat.id.toString());
  const count = await incrementWarning(target.id.toString(), ctx.chat.id.toString());
  const max = s?.maxWarnings ?? 3;
  if (count >= max) {
    await applyPunishment(ctx, target, s?.punishment ?? "mute", count, max, ctx.chat.id.toString());
  } else {
    const msg = await ctx.reply(
      `⚠️ ${mention(target)} — Warning <b>${count}/${max}</b>\n<i>${max - count} remaining.</i>`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 15000);
  }
});

bot.command("unwarn", async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const target = ctx.message?.reply_to_message?.from;
  if (!target) return;
  await resetWarning(target.id.toString(), ctx.chat.id.toString());
  const msg = await ctx.reply(`✅ Cleared warnings for ${mention(target)}.`, { parse_mode: "HTML" });
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 8000);
});

bot.command("warns", async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const target = ctx.message?.reply_to_message?.from;
  if (!target) return;
  const rows = await db.select().from(warningsTable)
    .where(and(eq(warningsTable.userId, target.id.toString()), eq(warningsTable.groupId, ctx.chat.id.toString())));
  const s = await getGroupSettings(ctx.chat.id.toString());
  const count = rows[0]?.count ?? 0;
  const max = s?.maxWarnings ?? 3;
  const msg = await ctx.reply(
    `📋 ${mention(target)} has <b>${count}/${max}</b> warnings.`,
    { parse_mode: "HTML" }
  );
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 10000);
});

// ─── /mute /unmute ────────────────────────────────────────────────────────────

bot.command("mute", async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const target = ctx.message?.reply_to_message?.from;
  if (!target || target.is_bot) return;
  await muteUser(ctx.chat.id, target.id);
  await logActivity({ type: "mute", details: "Manual mute by admin", userId: target.id.toString(), groupId: ctx.chat.id.toString() });
  const botMe = await bot.api.getMe();
  const keyboard = new InlineKeyboard().url("👉 Unmute Me", `https://t.me/${botMe.username}?start=unmute_${ctx.chat.id}`);
  const msg = await ctx.reply(
    `🔇 ${mention(target)} has been muted.\n\nRemove any invite links from your bio then tap below:`,
    { parse_mode: "HTML", reply_markup: keyboard }
  );
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 30000);
});

bot.command("unmute", async (ctx) => {
  if (!ctx.from || ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const target = ctx.message?.reply_to_message?.from;
  if (!target) return;
  await unmuteUser(ctx.chat.id, target.id);
  await resetWarning(target.id.toString(), ctx.chat.id.toString());
  const msg = await ctx.reply(`✅ ${mention(target)} unmuted and warnings reset.`, { parse_mode: "HTML" });
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 8000);
});

// ─── /leaderboard ─────────────────────────────────────────────────────────────

bot.command("leaderboard", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const groupId = ctx.chat.id.toString();
  const warnings = await db.select().from(warningsTable).where(eq(warningsTable.groupId, groupId));
  const sorted = warnings.filter((w) => w.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);
  const settings = await getGroupSettings(groupId);
  const max = settings?.maxWarnings ?? 3;
  const medals = ["🥇", "🥈", "🥉"];
  if (sorted.length === 0) {
    const msg = await ctx.reply("🏆 No violations yet — this group is clean!");
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 15000);
    return;
  }
  let text = `🏆 <b>Top Violators</b>\n\n`;
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i];
    const medal = medals[i] ?? `${i + 1}.`;
    const user = await db.select().from(usersTable).where(eq(usersTable.id, w.userId));
    const name = user[0]?.firstName ?? `User ${w.userId}`;
    const bar = "▓".repeat(Math.min(w.count, max)) + "░".repeat(Math.max(0, max - w.count));
    text += `${medal} <b>${name}</b> — ${w.count}/${max} [${bar}]\n`;
  }
  const msg = await ctx.reply(text, { parse_mode: "HTML" });
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {}), 30000);
});

// ─── /setbackup ───────────────────────────────────────────────────────────────

bot.command("setbackup", async (ctx) => {
  if (ctx.chat.type === "private") return;
  if (!await isAdmin(ctx)) return;
  try { await ctx.deleteMessage(); } catch {}
  const input = ctx.match?.trim();
  if (!input) {
    const m = await ctx.reply("Usage: /setbackup @groupOrChannel\nTo remove: /setbackup off");
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 6000);
    return;
  }
  if (input.toLowerCase() === "off") {
    await db.update(groupSettingsTable).set({ backupChannel: null }).where(eq(groupSettingsTable.groupId, ctx.chat.id.toString()));
    const m = await ctx.reply("✅ Backup group removed. Membership gate and archiving disabled.");
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 6000);
    return;
  }
  await db.update(groupSettingsTable).set({ backupChannel: input }).where(eq(groupSettingsTable.groupId, ctx.chat.id.toString()));
  const m = await ctx.reply(
    `✅ Backup group set to <b>${input}</b>.\n\n` +
    `• Non-members will be warned (3 strikes → muted)\n` +
    `• Deleted messages will be archived there\n\n` +
    `⚠️ Make sure I'm an <b>admin</b> in ${input} too!`,
    { parse_mode: "HTML" }
  );
  setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 10000);
});

// ─── /botinfo /maintenance ────────────────────────────────────────────────────

bot.command("botinfo", async (ctx) => {
  if (!isOwner(ctx.from!.id)) return;
  const [groups, users] = await Promise.all([
    db.select().from(groupsTable).then((r) => r.filter((g) => g.isActive).length),
    db.select().from(usersTable).then((r) => r.length),
  ]);
  await ctx.reply(
    `🥂 <b>${BOT_USERNAME} Info</b>\n\n` +
    `📊 Active Groups: <b>${groups}</b>\n👥 Users: <b>${users}</b>`,
    { parse_mode: "HTML" }
  );
});

bot.command("maintenance", async (ctx) => {
  if (!isOwner(ctx.from!.id)) return;
  const on = ctx.match?.toLowerCase() === "on";
  await db.update(botSettingsTable).set({ maintenanceMode: on }).where(eq(botSettingsTable.id, "singleton"));
  await ctx.reply(`✅ Maintenance mode <b>${on ? "ON" : "OFF"}</b>`, { parse_mode: "HTML" });
});

// ─── Broadcast commands ───────────────────────────────────────────────────────

async function performBroadcast(message: string, target: "users" | "groups" | "both", pin: boolean, replyCtx: Context) {
  const targets = await getUserIdsByType(target);
  let success = 0, fail = 0;
  for (let i = 0; i < targets.length; i++) {
    try {
      const sent = await bot.api.sendMessage(Number(targets[i].id), message, { parse_mode: "HTML" });
      if (pin) await bot.api.pinChatMessage(Number(targets[i].id), sent.message_id).catch(() => {});
      success++;
    } catch { fail++; }
    if (i % 25 === 24) await delay(1000);
  }
  await saveBroadcastHistory({ message, target, successCount: success, failCount: fail, pinned: pin });
  await logActivity({ type: "broadcast", details: `${target}: ${success} ok, ${fail} fail` });
  await replyCtx.reply(
    `✅ <b>Broadcast done!</b>\n📤 Sent: <b>${success}</b>\n❌ Failed: <b>${fail}</b>\n📌 Pinned: <b>${pin ? "Yes" : "No"}</b>`,
    { parse_mode: "HTML" }
  );
}

bot.command("broadcast", async (ctx) => {
  if (!isOwner(ctx.from!.id)) return;
  const text = ctx.match?.trim();
  if (!text) { await ctx.reply("Usage: /broadcast <message>\nAdd -pin at end to pin."); return; }
  const shouldPin = text.endsWith("-pin");
  await ctx.reply("📢 Broadcasting to everyone...");
  await performBroadcast(shouldPin ? text.slice(0, -4).trim() : text, "both", shouldPin, ctx);
});

bot.command("broadcastusers", async (ctx) => {
  if (!isOwner(ctx.from!.id)) return;
  const text = ctx.match?.trim();
  if (!text) return;
  await ctx.reply("📢 Broadcasting to users...");
  await performBroadcast(text, "users", false, ctx);
});

bot.command("broadcastgroups", async (ctx) => {
  if (!isOwner(ctx.from!.id)) return;
  const text = ctx.match?.trim();
  if (!text) return;
  await ctx.reply("📢 Broadcasting to groups...");
  await performBroadcast(text, "groups", false, ctx);
});

// ─── Bot added/removed ────────────────────────────────────────────────────────

bot.on("my_chat_member", async (ctx) => {
  const update = ctx.myChatMember;
  const chat = ctx.chat;
  if (chat.type !== "group" && chat.type !== "supergroup") return;
  const newStatus = update.new_chat_member.status;
  const oldStatus = update.old_chat_member.status;
  if (newStatus === "administrator" && oldStatus !== "administrator") {
    await upsertGroup({ id: chat.id.toString(), title: chat.title, isActive: true });
    try {
      await ctx.reply(
        `🥂 <b>${BOT_USERNAME} is now active!</b>\n\n` +
        `I'll protect this group from bio-link spammers and enforce backup group membership.\n\n` +
        `Use /settings to configure warnings, punishments, and more.`,
        { parse_mode: "HTML" }
      );
    } catch {}
  } else if (newStatus === "left" || newStatus === "kicked") {
    await db.update(groupsTable).set({ isActive: false, updatedAt: new Date() }).where(eq(groupsTable.id, chat.id.toString()));
  }
});

// ─── Message handler ──────────────────────────────────────────────────────────

bot.on("message", async (ctx) => {
  const chat = ctx.chat;

  // Handle private: owner support replies via LOGS_CHAT_ID
  if (chat.type === "private") {
    if (LOGS_CHAT_ID && ctx.chat.id.toString() === LOGS_CHAT_ID && ctx.message.reply_to_message) {
      const replyTo = ctx.message.reply_to_message;
      const mapping = await getMessageMap(replyTo.message_id.toString()).catch(() => null);
      if (!mapping) return;
      try {
        await bot.api.sendMessage(
          Number(mapping.userId),
          `📩 <b>Message from support:</b>\n\n${ctx.message.text}`,
          { parse_mode: "HTML" }
        );
        await ctx.react("👍").catch(() => {});
      } catch {
        await ctx.reply("❌ Could not deliver — user may have blocked the bot.");
      }
    }
    return;
  }

  const from = ctx.from;
  if (!from || from.is_bot) return;

  await upsertUser({ id: from.id.toString(), firstName: from.first_name, username: from.username, type: "user" });

  // Maintenance check
  const [botSettings] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, "singleton"));
  if (botSettings?.maintenanceMode) return;

  const settings = await getGroupSettings(chat.id.toString());
  if (!settings) return;

  // ── Check 1: Backup group membership (with 3-strike warning system) ──────────
  // Tracked separately from bio-link warnings using a namespaced key
  let failedMembershipCheck = false;
  if (settings.backupChannel) {
    let isMember = false;
    try {
      const member = await bot.api.getChatMember(settings.backupChannel, from.id);
      isMember = !["left", "kicked"].includes(member.status);
    } catch (err: any) {
      logger.warn(
        { err: err?.message ?? err, backupChannel: settings.backupChannel },
        "Backup group membership check failed — bot may not be admin in the backup group/channel"
      );
      // Notify owner once so they can fix permissions
      if (OWNER_ID) {
        bot.api.sendMessage(
          Number(OWNER_ID),
          `⚠️ <b>Backup group check failed</b>\n\nGroup: <b>${chat.title}</b>\nBackup: <code>${settings.backupChannel}</code>\n\n❗ Make sure the bot is an <b>admin</b> in that group/channel.\n\n<i>Error: ${err?.message ?? "Unknown"}</i>`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
    }

    if (!isMember) {
      failedMembershipCheck = true;
      try { await ctx.deleteMessage(); } catch {}

      // Use a separate namespaced warning key for backup group violations
      const backupWarnKey = `backup_${from.id}_${chat.id}`;
      const warnCount = await incrementWarning(backupWarnKey, chat.id.toString());
      const maxWarnings = settings.maxWarnings;
      const remaining = maxWarnings - warnCount;
      const cleanHandle = settings.backupChannel.replace("@", "");
      const joinKeyboard = new InlineKeyboard().url("⌛ Join Required Group", `https://t.me/${cleanHandle}`);

      if (warnCount >= maxWarnings) {
        // Max strikes reached — apply punishment
        await applyPunishment(ctx, from, settings.punishment, warnCount, maxWarnings, chat.id.toString(), "backup_group");
        await resetWarning(backupWarnKey, chat.id.toString());
        return;
      }

      if (warnCount === 1) {
        // Strike 1 — silent delete + join button
        const m = await ctx.reply(
          `⌛ ${mention(from)}, you must join our required group before chatting here!\n\nJoin then send your message again.`,
          { parse_mode: "HTML", reply_markup: joinKeyboard }
        );
        setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 20000);
      } else {
        // Strike 2..max-1 — explicit warning
        if (settings.silentMode) {
          bot.api.sendMessage(
            from.id,
            `⚠️ <b>Warning ${warnCount}/${maxWarnings}</b> in <b>${chat.title}</b>\n\nYou must join the required group to chat there. ${remaining} warning${remaining > 1 ? "s" : ""} left before action.`,
            { parse_mode: "HTML", reply_markup: joinKeyboard }
          ).catch(() => {});
        } else {
          const warnMsg = await ctx.reply(
            `⚠️ ${mention(from)} — Warning <b>${warnCount}/${maxWarnings}</b>\n\n` +
            `You must join the required group to chat here!\n` +
            `<i>${remaining} more warning${remaining > 1 ? "s" : ""} before action.</i>`,
            { parse_mode: "HTML", reply_markup: joinKeyboard }
          );
          setTimeout(() => ctx.api.deleteMessage(chat.id, warnMsg.message_id).catch(() => {}), 20000);
        }
      }
    } else {
      // User joined — reset their backup group warning streak if any
      const backupWarnKey = `backup_${from.id}_${chat.id}`;
      const existingRows = await db.select().from(warningsTable)
        .where(and(eq(warningsTable.userId, backupWarnKey), eq(warningsTable.groupId, chat.id.toString())));
      if (existingRows[0]?.count) {
        await resetWarning(backupWarnKey, chat.id.toString());
      }
    }
  }

  // ── Check 2: Bio link check (always runs, independent of check 1) ────────────
  let bio: string | null = null;
  try { bio = await getUserBio(from.id); } catch {}

  const hasLink = settings.antiBypassing
    ? containsTelegramLink(bio ?? "") || containsTelegramLink((bio ?? "").replace(/\s/g, ""))
    : containsTelegramLink(bio ?? "");

  if (!hasLink) return; // Bio is clean — done

  // Delete message (skip if already deleted by check 1)
  if (!failedMembershipCheck) {
    try { await ctx.deleteMessage(); } catch {}
  }

  // Archive deleted message to backup channel
  if (settings.backupChannel) {
    try { await bot.api.forwardMessage(settings.backupChannel, chat.id, ctx.message.message_id); } catch {}
  }

  const warnCount = await incrementWarning(from.id.toString(), chat.id.toString());
  const maxWarnings = settings.maxWarnings;
  const remaining = maxWarnings - warnCount;

  await logActivity({
    type: "link_detected",
    details: `Bio link — warning ${warnCount}/${maxWarnings}`,
    userId: from.id.toString(),
    groupId: chat.id.toString(),
  });

  if (warnCount >= maxWarnings) {
    await applyPunishment(ctx, from, settings.punishment, warnCount, maxWarnings, chat.id.toString(), "bio_link");
    return;
  }

  // Strike 1 — silent ⌛
  if (warnCount === 1) {
    try {
      const msg = await ctx.reply(`⌛`);
      setTimeout(() => ctx.api.deleteMessage(chat.id, msg.message_id).catch(() => {}), 5000);
    } catch {}
    return;
  }

  // Strikes 2..max-1 — warning
  if (settings.silentMode) {
    bot.api.sendMessage(
      from.id,
      `⚠️ <b>Warning ${warnCount}/${maxWarnings}</b> in <b>${chat.title}</b>\n\nYour bio has a Telegram link. Remove it — ${remaining} warning${remaining > 1 ? "s" : ""} left before action.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } else {
    const warnMsg = await ctx.reply(
      `⚠️ ${mention(from)} — Warning <b>${warnCount}/${maxWarnings}</b>\n\n` +
      `🔗 Your bio contains a Telegram link. Remove it!\n` +
      `<i>${remaining} more warning${remaining > 1 ? "s" : ""} before action.</i>`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => ctx.api.deleteMessage(chat.id, warnMsg.message_id).catch(() => {}), 20000);
  }
});

// ─── Bio recheck callback ─────────────────────────────────────────────────────

bot.callbackQuery(/^recheck_bio_(.+)$/, async (ctx) => {
  await ack(ctx, "🔍 Checking your bio...");
  if (!ctx.from) return;
  const groupId = ctx.match[1];
  await handleUnmuteFlow(ctx, groupId);
});

// ─── Settings callbacks ───────────────────────────────────────────────────────

bot.callbackQuery(/^menu_main_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const chat = await bot.api.getChat(Number(groupId)).catch(() => ({ title: "Group" }));
  const { text, keyboard } = await buildMainSettingsMenu(groupId, (chat as any).title || "Group");
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_warn_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildWarnMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_punish_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildPunishMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_silent_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildSilentMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_antibypass_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildAntiBypassMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_backup_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildBackupMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_stats_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const { text, keyboard } = await buildStatsMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^menu_leaderboard_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const warnings = await db.select().from(warningsTable).where(eq(warningsTable.groupId, groupId));
  const sorted = warnings.filter((w) => w.count > 0).sort((a, b) => b.count - a.count).slice(0, 10);
  const settings = await getGroupSettings(groupId);
  const max = settings?.maxWarnings ?? 3;
  const medals = ["🥇", "🥈", "🥉"];
  let text = `🏆 <b>Top Violators</b>\n\n`;
  if (sorted.length === 0) {
    text += "No violations yet. Clean group! 🎉";
  } else {
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      const medal = medals[i] ?? `${i + 1}.`;
      const user = await db.select().from(usersTable).where(eq(usersTable.id, w.userId));
      const name = user[0]?.firstName ?? `User ${w.userId}`;
      const bar = "▓".repeat(Math.min(w.count, max)) + "░".repeat(Math.max(0, max - w.count));
      text += `${medal} <b>${name}</b> — ${w.count}/${max} [${bar}]\n`;
    }
  }
  await safeEdit(ctx, text, { reply_markup: new InlineKeyboard().text("« Back", `menu_main_${groupId}`) });
});

bot.callbackQuery("close_menu", async (ctx) => {
  await ack(ctx);
  await ctx.deleteMessage().catch(() => {});
});

bot.callbackQuery("noop", async (ctx) => { await ack(ctx); });

// ─── Toggle callbacks ─────────────────────────────────────────────────────────

bot.callbackQuery(/^setwarn_(.+)_([123])$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const count = parseInt(ctx.match[2]);
  await db.update(groupSettingsTable).set({ maxWarnings: count }).where(eq(groupSettingsTable.groupId, groupId));
  const { text, keyboard } = await buildWarnMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^setpunish_(.+)_(mute|ban|kick)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const punishment = ctx.match[2];
  await db.update(groupSettingsTable).set({ punishment }).where(eq(groupSettingsTable.groupId, groupId));
  const { text, keyboard } = await buildPunishMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^toggle_silent_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const s = await getGroupSettings(groupId);
  if (!s) return;
  await db.update(groupSettingsTable).set({ silentMode: !s.silentMode }).where(eq(groupSettingsTable.groupId, groupId));
  const { text, keyboard } = await buildSilentMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

bot.callbackQuery(/^toggle_antibypass_(.+)$/, async (ctx) => {
  await ack(ctx);
  const groupId = ctx.match[1];
  const s = await getGroupSettings(groupId);
  if (!s) return;
  await db.update(groupSettingsTable).set({ antiBypassing: !s.antiBypassing }).where(eq(groupSettingsTable.groupId, groupId));
  const { text, keyboard } = await buildAntiBypassMenu(groupId);
  await safeEdit(ctx, text, { reply_markup: keyboard });
});

// ─── Owner panel callbacks ────────────────────────────────────────────────────

bot.callbackQuery("how_it_works", async (ctx) => {
  await ack(ctx);
  await safeEdit(ctx,
    `ℹ️ <b>How ${BOT_USERNAME} Works</b>\n\n` +
    `On every message, <b>two checks run independently:</b>\n\n` +
    `<b>1️⃣ Backup Group Gate</b> (if configured)\n` +
    `User must be a member of your backup group/channel.\n` +
    `• Strike 1 — Message deleted + ⌛ join button\n` +
    `• Strike 2 — Warning message sent\n` +
    `• Strike 3 — User muted/banned\n\n` +
    `<b>2️⃣ Bio Link Check</b>\n` +
    `User's Telegram bio is scanned for invite links.\n` +
    `• Strike 1 — ⌛ silent delete\n` +
    `• Strike 2 — Warning message sent\n` +
    `• Strike 3 — User muted/banned\n\n` +
    `<b>🔓 Unmuting:</b>\n` +
    `User taps the button → opens bot in DM → removes bio link → taps Check Again → instantly unmuted!\n\n` +
    `<i>Both checks run on every message, independently.</i>`,
    { reply_markup: new InlineKeyboard().text("« Back", "back_to_start") }
  );
});

bot.callbackQuery("show_commands", async (ctx) => {
  await ack(ctx);
  await safeEdit(ctx,
    `📋 <b>Commands</b>\n\n` +
    `<b>Group (admins only):</b>\n` +
    `/settings — Open settings menu\n` +
    `/warn — Warn a user (reply to msg)\n` +
    `/unwarn — Clear warnings (reply)\n` +
    `/warns — Check user warnings (reply)\n` +
    `/mute — Mute a user (reply)\n` +
    `/unmute — Unmute a user (reply)\n` +
    `/leaderboard — Top violators list\n` +
    `/setbackup @group — Set backup group\n\n` +
    `<b>Owner only:</b>\n` +
    `/broadcast <msg> — Broadcast to all\n` +
    `/botinfo — Bot stats\n` +
    `/maintenance on|off — Toggle maintenance`,
    { reply_markup: new InlineKeyboard().text("« Back", "back_to_start") }
  );
});

bot.callbackQuery("contact_support", async (ctx) => {
  await ack(ctx);
  await safeEdit(ctx,
    `👨‍💻 <b>Support</b>\n\n` +
    `If you're experiencing issues or have questions, please reach out to the bot owner.\n\n` +
    `You can also use /settings in your group to configure the bot.\n\n` +
    `<i>Common issues:</i>\n` +
    `• Bot not responding → Make sure it has admin rights\n` +
    `• Backup group not working → Bot must be admin there too\n` +
    `• Users not getting muted → Check Restrict Members permission`,
    { reply_markup: new InlineKeyboard().text("« Back", "back_to_start") }
  );
});

bot.callbackQuery("back_to_start", async (ctx) => {
  await ack(ctx);
  if (!ctx.from) return;
  const botMe = await bot.api.getMe();
  const keyboard = new InlineKeyboard()
    .url("➕ Add to My Group", `https://t.me/${botMe.username}?startgroup=true`).row()
    .text("ℹ️ How It Works", "how_it_works")
    .text("📋 Commands", "show_commands").row()
    .text("👨‍💻 Support", "contact_support");
  await safeEdit(ctx,
    `👋 <b>Welcome to ${BOT_USERNAME}!</b>\n\n` +
    `🛡 I protect Telegram groups from users who have <b>invite links in their bios</b>.\n\n` +
    `<b>✅ What I do:</b>\n` +
    `• Detect bio links (even disguised ones)\n` +
    `• Warn users automatically (3 strikes)\n` +
    `• Mute / Ban / Kick at your choice\n` +
    `• Enforce backup group membership\n` +
    `• Let users self-unmute after fixing their bio\n\n` +
    `<i>Tap ➕ Add to My Group to get started.</i>`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery("owner_stats", async (ctx) => {
  await ack(ctx);
  if (!isOwner(ctx.from.id)) return;
  const [groups, users, warns] = await Promise.all([
    db.select().from(groupsTable),
    db.select().from(usersTable),
    db.select().from(warningsTable),
  ]);
  await safeEdit(ctx,
    `📊 <b>Bot Statistics</b>\n\n` +
    `🏠 Active Groups: <b>${groups.filter((g) => g.isActive).length}</b>\n` +
    `👥 Total Users: <b>${users.length}</b>\n` +
    `⚠️ Total Warnings: <b>${warns.reduce((s, w) => s + w.count, 0)}</b>`,
    { reply_markup: new InlineKeyboard().text("« Back", "back_to_owner") }
  );
});

bot.callbackQuery("owner_broadcast_menu", async (ctx) => {
  await ack(ctx);
  if (!isOwner(ctx.from.id)) return;
  await safeEdit(ctx,
    `📢 <b>Broadcast</b>\n\nCommands:\n` +
    `/broadcast <msg> — Send to everyone\n` +
    `/broadcastusers <msg> — Users only\n` +
    `/broadcastgroups <msg> — Groups only\n\n` +
    `Add <code>-pin</code> at the end to pin the message.`,
    { reply_markup: new InlineKeyboard().text("« Back", "back_to_owner") }
  );
});

bot.callbackQuery("owner_settings", async (ctx) => {
  await ack(ctx);
  if (!isOwner(ctx.from.id)) return;
  const settings = await db.select().from(botSettingsTable).limit(1);
  const s = settings[0];
  await safeEdit(ctx,
    `⚙️ <b>Global Bot Settings</b>\n\n🔧 Maintenance Mode: <b>${s?.maintenanceMode ? "ON" : "OFF"}</b>`,
    {
      reply_markup: new InlineKeyboard()
        .text(`${s?.maintenanceMode ? "✅" : "❌"} Maintenance`, "toggle_maintenance").row()
        .text("« Back", "back_to_owner"),
    }
  );
});

bot.callbackQuery("back_to_owner", async (ctx) => {
  await ack(ctx);
  if (!isOwner(ctx.from.id)) return;
  const [totalGroups, totalUsers] = await Promise.all([
    db.select().from(groupsTable).then((r) => r.filter((g) => g.isActive).length),
    db.select().from(usersTable).then((r) => r.length),
  ]);
  const keyboard = new InlineKeyboard()
    .text("📢 Broadcast", "owner_broadcast_menu").text("📊 Stats", "owner_stats").row()
    .text("⚙️ Bot Settings", "owner_settings").text("📋 Commands", "show_commands");
  await safeEdit(ctx,
    `🥂 <b>${BOT_USERNAME} — Owner Panel</b>\n\n📊 <b>Live Stats:</b>\n├ 🏠 Groups: <b>${totalGroups}</b>\n└ 👥 Users: <b>${totalUsers}</b>`,
    { reply_markup: keyboard }
  );
});

bot.callbackQuery("toggle_maintenance", async (ctx) => {
  await ack(ctx);
  if (!isOwner(ctx.from.id)) return;
  const settings = await db.select().from(botSettingsTable).limit(1);
  const cur = settings[0]?.maintenanceMode ?? false;
  await db.update(botSettingsTable).set({ maintenanceMode: !cur }).where(eq(botSettingsTable.id, "singleton"));
  await safeEdit(ctx,
    `⚙️ <b>Global Bot Settings</b>\n\n🔧 Maintenance Mode: <b>${!cur ? "ON" : "OFF"}</b>`,
    {
      reply_markup: new InlineKeyboard()
        .text(`${!cur ? "✅" : "❌"} Maintenance`, "toggle_maintenance").row()
        .text("« Back", "back_to_owner"),
    }
  );
});

// ─── Error handler ────────────────────────────────────────────────────────────

bot.catch((err) => {
  logger.error({ err: err.error, updateId: err.ctx.update.update_id }, "Bot error");
});

// ─── Start ────────────────────────────────────────────────────────────────────

export async function startBot() {
  await ensureBotSettings();
  bot.start();
  logger.info(`${BOT_USERNAME} started (long polling)`);
}
