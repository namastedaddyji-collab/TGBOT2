// ================== IMPORTS ==================
import { Bot, InlineKeyboard } from "grammy";
import mongoose from "mongoose";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID);
const LOG_GROUP_ID = Number(process.env.LOG_GROUP_ID);

if (!BOT_TOKEN) throw new Error("BOT_TOKEN missing");

const bot = new Bot(BOT_TOKEN);

// ================== DB ==================
await mongoose.connect(process.env.MONGO_URI);
console.log("✅ Mongo Connected");

// ================== SCHEMAS ==================
const userSchema = new mongoose.Schema({
  userId: String,
  firstName: String,
  username: String,
  started: { type: Boolean, default: false },
  warnings: [
    {
      groupId: String,
      count: { type: Number, default: 0 },
      graceUsed: { type: Boolean, default: false },
    },
  ],
});
const User = mongoose.model("User", userSchema);

const groupSchema = new mongoose.Schema({
  groupId: String,
  title: String,
  settings: {
    maxWarnings: { type: Number, default: 3 },
    punishment: { type: "String", default: "mute" },
    forceJoinEnabled: { type: Boolean, default: false },
    forceJoinChannel: String,
    globalBanSync: { type: Boolean, default: false },
  },
});
const Group = mongoose.model("Group", groupSchema);

const globalBanSchema = new mongoose.Schema({
  userId: String,
});
const GlobalBan = mongoose.model("GlobalBan", globalBanSchema);

// ================== HELPERS ==================
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mention(u) {
  return `<a href="tg://user?id=${u.id}">${u.first_name}</a>`;
}

function hasLink(text) {
  return /(t\.me|telegram\.me|@\w+)/i.test(text || "");
}

async function getBio(id) {
  try {
    const c = await bot.api.getChat(id);
    return c.bio || "";
  } catch {
    return "";
  }
}

async function getUser(userId) {
  let u = await User.findOne({ userId });
  if (!u) u = await User.create({ userId });
  return u;
}

async function getGroup(chat) {
  let g = await Group.findOne({ groupId: String(chat.id) });
  if (!g) {
    g = await Group.create({
      groupId: String(chat.id),
      title: chat.title,
    });
  }
  return g;
}

// ================== START ==================
bot.command("start", async (ctx) => {
  const payload = ctx.match;
  const userId = String(ctx.from.id);

  const user = await getUser(userId);
  user.started = true;
  await user.save();

  // UNMUTE FLOW
  if (payload?.startsWith("unmute_")) {
    const groupId = payload.split("_")[1];
    const bio = await getBio(ctx.from.id);

    if (hasLink(bio)) {
      return ctx.reply("❌ Remove link from your bio first.");
    }

    try {
      await bot.api.restrictChatMember(Number(groupId), ctx.from.id, {
        permissions: { can_send_messages: true },
      });
    } catch {}

    return ctx.reply("✅ You are unmuted!");
  }

  await ctx.reply("🥂 GlassGuard PRO is active!");
});

// ================== FORCE JOIN ==================
async function checkForceJoin(ctx, group) {
  if (!group.settings.forceJoinEnabled) return false;

  try {
    const member = await bot.api.getChatMember(
      group.settings.forceJoinChannel,
      ctx.from.id
    );

    if (["left", "kicked"].includes(member.status)) {
      const btn = new InlineKeyboard().url(
        "Join Channel",
        `https://t.me/${group.settings.forceJoinChannel.replace("@", "")}`
      );

      const msg = await ctx.reply("🔐 Join required channel.", {
        reply_markup: btn,
      });

      setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id), 5000);
      return true;
    }
  } catch {}
  return false;
}

// ================== MAIN MESSAGE HANDLER ==================
bot.on("message", async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  // ================= PRIVATE (LIVEGRAM) =================
  if (ctx.chat.type === "private") {
    if (String(ctx.from.id) === OWNER_ID) return;

    const sent = await bot.api.forwardMessage(
      LOG_GROUP_ID,
      ctx.chat.id,
      ctx.message.message_id
    );

    await bot.api.sendMessage(
      LOG_GROUP_ID,
      `👤 ${ctx.from.id}`,
      { reply_to_message_id: sent.message_id }
    );

    return;
  }

  // ================= GROUP LOGIC =================
  const userId = String(ctx.from.id);
  const group = await getGroup(ctx.chat);
  const user = await getUser(userId);

  // FORCE JOIN
  if (await checkForceJoin(ctx, group)) {
    try { await ctx.deleteMessage(); } catch {}
    return;
  }

  // GLOBAL BAN
  if (group.settings.globalBanSync) {
    const gb = await GlobalBan.findOne({ userId });
    if (gb) {
      try { await ctx.banChatMember(ctx.from.id); } catch {}
      return;
    }
  }

  const bio = await getBio(ctx.from.id);
  if (!hasLink(bio)) return;

  try { await ctx.deleteMessage(); } catch {}

  let warn = user.warnings.find((w) => w.groupId === String(ctx.chat.id));
  if (!warn) {
    warn = { groupId: String(ctx.chat.id), count: 0, graceUsed: false };
    user.warnings.push(warn);
  }

  // GRACE
  if (!warn.graceUsed) {
    warn.graceUsed = true;
    await user.save();

    const msg = await ctx.reply(
      `⌛ ${mention(ctx.from)} remove link from bio`,
      { parse_mode: "HTML" }
    );
    setTimeout(() => ctx.api.deleteMessage(ctx.chat.id, msg.message_id), 6000);
    return;
  }

  // WARN
  warn.count++;
  await user.save();

  if (warn.count >= group.settings.maxWarnings) {
    if (group.settings.punishment === "ban") {
      await ctx.banChatMember(ctx.from.id);
    } else {
      await bot.api.restrictChatMember(ctx.chat.id, ctx.from.id, {
        permissions: { can_send_messages: false },
      });
    }

    if (group.settings.globalBanSync) {
      await GlobalBan.create({ userId });
    }

    const me = await bot.api.getMe();
    const kb = new InlineKeyboard().url(
      "👉 Unmute",
      `https://t.me/${me.username}?start=unmute_${ctx.chat.id}`
    );

    await ctx.reply(`🔇 ${mention(ctx.from)} punished`, {
      parse_mode: "HTML",
      reply_markup: kb,
    });
    return;
  }

  await ctx.reply(
    `⚠️ ${mention(ctx.from)} warning ${warn.count}/${group.settings.maxWarnings}`,
    { parse_mode: "HTML" }
  );
});

// ================== OWNER REPLY (LIVEGRAM) ==================
bot.on("message", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  if (ctx.chat.id !== LOG_GROUP_ID) return;

  if (!ctx.message.reply_to_message) return;

  const text = ctx.message.reply_to_message.text;
  if (!text?.includes("👤")) return;

  const userId = text.split(" ")[1];

  await bot.api.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
});

// ================== LEADERBOARD ==================
bot.command("top", async (ctx) => {
  if (ctx.chat.type === "private") return;

  const users = await User.find({});
  const arr = [];

  users.forEach((u) => {
    const w = u.warnings.find((x) => x.groupId === String(ctx.chat.id));
    if (w && w.count > 0) arr.push({ userId: u.userId, count: w.count });
  });

  arr.sort((a, b) => b.count - a.count);

  let text = `🏆 <b>Top Violators</b>\n\n`;

  arr.slice(0, 10).forEach((u, i) => {
    text += `${i + 1}. <a href="tg://user?id=${u.userId}">User</a> — ${u.count}\n`;
  });

  ctx.reply(text, { parse_mode: "HTML" });
});

// ================== BROADCAST ==================
bot.command("broadcast", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;

  const msg = ctx.message.reply_to_message;
  if (!msg) return ctx.reply("Reply to message");

  const users = await User.find({ started: true });

  let sent = 0;

  for (let u of users) {
    try {
      await bot.api.copyMessage(u.userId, ctx.chat.id, msg.message_id);
      sent++;
      await delay(40);
    } catch {}
  }

  ctx.reply(`✅ Sent to ${sent} users`);
});

// ================== START BOT ==================
bot.start();
console.log("🚀 Bot Started");
