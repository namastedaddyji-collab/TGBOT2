import { Bot, InlineKeyboard } from "grammy";
import { containsTelegramLink } from "./linkDetector.js";
import {
  upsertUser,
  upsertGroup,
  getGroupSettings,
  incrementWarning,
  resetWarning,
  logActivity,
  saveMessageMap,
  getMessageMap,
  adjustReputation,
  ensureBotSettings,
  db,
  botSettingsTable,
} from "./db.js";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger.js";

const BOT_TOKEN = process.env["BOT_TOKEN"];
const OWNER_ID = process.env["BOT_OWNER_ID"] ? Number(process.env["BOT_OWNER_ID"]) : 0;
const LOGS_CHAT_ID = process.env["LOGS_CHAT_ID"] || "";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is required");

export const bot = new Bot(BOT_TOKEN);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isOwner(userId) {
  return Number(userId) === OWNER_ID;
}

async function isAdmin(ctx) {
  if (!ctx.from || !ctx.chat) return false;
  if (isOwner(ctx.from.id)) return true;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return ["administrator", "creator"].includes(member.status);
  } catch {
    return false;
  }
}

async function sendLog(text, extra = {}) {
  if (!LOGS_CHAT_ID) return;
  try {
    return await bot.api.sendMessage(LOGS_CHAT_ID, text, { parse_mode: "HTML", ...extra });
  } catch (e) {
    logger.error({ err: e }, "Failed to send log");
  }
}

async function getUserBio(userId) {
  try {
    const chat = await bot.api.getChat(userId);
    return chat.bio ?? null;
  } catch {
    return null;
  }
}

function mention(user) {
  return `<a href="tg://user?id=${user.id}">${user.first_name}</a>`;
}

async function safeEdit(ctx, text, opts = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: "HTML", ...opts });
  } catch {
    try {
      await ctx.reply(text, { parse_mode: "HTML", ...opts });
    } catch {}
  }
}

async function ack(ctx, text = "") {
  try {
    await ctx.answerCallbackQuery(text);
  } catch {}
}

// ─── Mute / Unmute ────────────────────────────────────────────────────────────
async function muteUser(chatId, userId) {
  await bot.api.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    },
  });
}

async function unmuteUser(chatId, userId) {
  await bot.api.restrictChatMember(chatId, userId, {
    permissions: {
      can_send_messages: true,
      can_send_audios: true,
      can_send_documents: true,
      can_send_photos: true,
      can_send_videos: true,
      can_send_video_notes: true,
      can_send_voice_notes: true,
      can_send_polls: true,
      can_send_other_messages: true,
      can_add_web_page_previews: true,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
    },
  });
}

// ─── Punishment ───────────────────────────────────────────────────────────────
async function applyPunishment(ctx, target, punishment, warnCount, maxWarns, groupId, reason = "bio_link") {
  const chatId = ctx.chat.id;
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
    logger.error({ err: e }, `Punishment (${punishment}) failed`);
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
  const keyboard = punishment !== "kick"
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
async function handleUnmuteFlow(ctx, groupId) {
  if (!ctx.from) return;
  const userId = ctx.from.id;

  const bio = await getUserBio(userId);
  const hasLink = containsTelegramLink(bio ?? "") || containsTelegramLink((bio ?? "").replace(/\s/g, ""));

  if (hasLink) {
    const keyboard = new InlineKeyboard().text("✅ I removed it — Check again", `recheck_bio_${groupId}`);
    await safeEdit(ctx,
      `🚫 <b>Your bio still has a Telegram link!</b>\n\n` +
      `📱 <b>Steps to fix:</b>\n1. Open Telegram Settings\n2. Tap Edit Profile\n3. Clear your Bio\n4. Come back and tap the button below`,
      { reply_markup: keyboard }
    );
    return;
  }

  const groupIdNum = Number(groupId);
  let memberStatus = "unknown";

  try {
    const member = await bot.api.getChatMember(groupIdNum, userId);
    memberStatus = member.status;
  } catch (e) {
    logger.error({ err: e }, "getChatMember failed in unmute");
    await safeEdit(ctx, `⚠️ Could not verify membership. Ask an admin to unmute you manually.`);
    return;
  }

  if (memberStatus === "restricted") {
    await unmuteUser(groupIdNum, userId).catch((e) => logger.error({ err: e }, "unmute failed"));
  } else if (["kicked", "left"].includes(memberStatus)) {
    await bot.api.unbanChatMember(groupIdNum, userId).catch((e) => logger.error({ err: e }, "unban failed"));
  }

  await adjustReputation(userId.toString(), 10);
  await resetWarning(userId.toString(), groupId);
  await resetWarning(`backup_${userId}_${groupId}`, groupId);

  await logActivity({
    type: "unmute",
    details: "User cleaned bio and was unmuted via button",
    userId: userId.toString(),
    groupId,
  });

  await safeEdit(ctx,
    `✅ <b>You're all clear!</b>\n\nYour bio is clean. Welcome back! 🥂\n\n<i>Reputation +10 • Warnings reset</i>`
  );
}

// ─── Message Handler ─────────────────────────────────────────────────────────
bot.on("message", async (ctx) => {
  const chat = ctx.chat;

  // Private chat support replies
  if (chat.type === "private") {
    if (LOGS_CHAT_ID && chat.id.toString() === LOGS_CHAT_ID && ctx.message?.reply_to_message) {
      const mapping = await getMessageMap(ctx.message.reply_to_message.message_id.toString()).catch(() => null);
      if (mapping && ctx.message.text) {
        try {
          await bot.api.sendMessage(Number(mapping.userId),
            `📩 <b>Message from support:</b>\n\n${ctx.message.text}`,
            { parse_mode: "HTML" }
          );
          await ctx.react("👍").catch(() => {});
        } catch {
          await ctx.reply("❌ Could not deliver message.");
        }
      }
    }
    return;
  }

  const from = ctx.from;
  if (!from || from.is_bot) return;

  await upsertUser({ 
    id: from.id.toString(), 
    firstName: from.first_name, 
    username: from.username, 
    type: "user" 
  });

  // Maintenance check
  const [botSettings] = await db.select().from(botSettingsTable).where(eq(botSettingsTable.id, "singleton"));
  if (botSettings?.maintenanceMode) return;

  const settings = await getGroupSettings(chat.id.toString());
  if (!settings) return;

  const groupIdStr = chat.id.toString();

  // ── 1. Backup Group Membership Check ─────────────────────────────────────
  let backupViolation = false;

  if (settings.backupChannel) {
    let isMember = false;
    try {
      const member = await bot.api.getChatMember(settings.backupChannel, from.id);
      isMember = !["left", "kicked"].includes(member.status);
    } catch (err) {
      logger.warn({ backupChannel: settings.backupChannel, err: err?.message }, "Backup membership check failed");
    }

    if (!isMember) {
      backupViolation = true;
      try { await ctx.deleteMessage(); } catch {}

      const backupKey = `backup_${from.id}_${chat.id}`;
      const warnCount = await incrementWarning(backupKey, groupIdStr);
      const max = settings.maxWarnings;

      if (warnCount >= max) {
        await applyPunishment(ctx, from, settings.punishment, warnCount, max, groupIdStr, "backup_group");
        await resetWarning(backupKey, groupIdStr);
        return;
      }

      // Smart join URL
      let joinUrl = "#";
      const ch = settings.backupChannel.trim();
      if (ch.startsWith("@")) {
        joinUrl = `https://t.me/${ch.replace("@", "")}`;
      } else if (ch.startsWith("-100")) {
        joinUrl = `https://t.me/c/${ch.replace("-100", "")}`;
      } else {
        joinUrl = `https://t.me/${ch}`;
      }

      const joinKeyboard = new InlineKeyboard().url("⌛ Join Required Group", joinUrl);

      if (warnCount === 1) {
        const m = await ctx.reply(`⌛ ${mention(from)}, you must join the required group first!`, { reply_markup: joinKeyboard });
        setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 25000);
      } else if (!settings.silentMode) {
        const m = await ctx.reply(
          `⚠️ ${mention(from)} — Warning <b>${warnCount}/${max}</b>\n\nJoin the required group!`,
          { reply_markup: joinKeyboard }
        );
        setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 20000);
      } else {
        bot.api.sendMessage(from.id, 
          `⚠️ Warning ${warnCount}/${max} — Join backup group to chat.`, 
          { reply_markup: joinKeyboard }
        ).catch(() => {});
      }
      return;
    } else {
      await resetWarning(`backup_${from.id}_${chat.id}`, groupIdStr).catch(() => {});
    }
  }

  // ── 2. Bio Link Check ─────────────────────────────────────────────────────
  let bio = null;
  try {
    bio = await getUserBio(from.id);
  } catch (e) {
    logger.error({ err: e, userId: from.id }, "Bio fetch failed");
  }

  const hasLink = settings.antiBypassing
    ? containsTelegramLink(bio ?? "") || containsTelegramLink((bio ?? "").replace(/\s/g, ""))
    : containsTelegramLink(bio ?? "");

  if (!hasLink) return;

  // Archive FIRST → then delete (Critical fix)
  if (settings.backupChannel) {
    try {
      await bot.api.forwardMessage(settings.backupChannel, chat.id, ctx.message.message_id);
    } catch (e) {
      logger.error({ err: e }, "Failed to archive message to backup");
    }
  }

  if (!backupViolation) {
    try {
      await ctx.deleteMessage();
    } catch (e) {
      logger.warn({ err: e }, "Failed to delete message");
    }
  }

  const warnCount = await incrementWarning(from.id.toString(), groupIdStr);
  const maxWarnings = settings.maxWarnings;

  await logActivity({
    type: "link_detected",
    details: `Bio link — warning ${warnCount}/${maxWarnings}`,
    userId: from.id.toString(),
    groupId: groupIdStr,
  });

  if (warnCount >= maxWarnings) {
    await applyPunishment(ctx, from, settings.punishment, warnCount, maxWarnings, groupIdStr, "bio_link");
    return;
  }

  if (warnCount === 1) {
    const m = await ctx.reply("⌛");
    setTimeout(() => ctx.api.deleteMessage(chat.id, m.message_id).catch(() => {}), 5000);
    return;
  }

  if (settings.silentMode) {
    bot.api.sendMessage(from.id,
      `⚠️ Warning ${warnCount}/${maxWarnings} in ${chat.title}\nRemove link from bio.`,
      { parse_mode: "HTML" }
    ).catch(() => {});
  } else {
    const msg = await ctx.reply(
      `⚠️ ${mention(from)} — Warning <b>${warnCount}/${maxWarnings}</b>\n\n🔗 Remove invite link from bio!`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => ctx.api.deleteMessage(chat.id, msg.message_id).catch(() => {}), 20000);
  }
});

// ─── Start Bot ────────────────────────────────────────────────────────────────
export async function startBot() {
  await ensureBotSettings();
  bot.start();
  logger.info("✅ BioGuard Bot started successfully");
}
