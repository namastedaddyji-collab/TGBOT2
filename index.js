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
const User = mongoose.model("User", new mongoose.Schema({
  userId: String,
  started: { type: Boolean, default: false },
  warnings: [
    { groupId: String, count: Number, graceUsed: Boolean }
  ]
}));

const Group = mongoose.model("Group", new mongoose.Schema({
  groupId: String,
  title: String,
  settings: {
    maxWarnings: { type: Number, default: 3 },
    punishment: { type: String, default: "mute" },
    forceJoinEnabled: { type: Boolean, default: false },
    forceJoinChannel: String,
    globalBanSync: { type: Boolean, default: false }
  }
}));

const GlobalBan = mongoose.model("GlobalBan", new mongoose.Schema({
  userId: String
}));

// ================== HELPERS ==================
function hasLink(text) {
  return /(t\.me|@\w+)/i.test(text || "");
}

async function getBio(id) {
  try {
    const c = await bot.api.getChat(id);
    return c.bio || "";
  } catch {
    return "";
  }
}

async function getUser(id) {
  let u = await User.findOne({ userId: id });
  if (!u) u = await User.create({ userId: id, warnings: [] });
  return u;
}

async function getGroup(chat) {
  let g = await Group.findOne({ groupId: String(chat.id) });
  if (!g) {
    g = await Group.create({
      groupId: String(chat.id),
      title: chat.title
    });
  }
  return g;
}

// ================== START UI ==================
bot.command("start", async (ctx) => {
  const payload = ctx.match;
  const userId = String(ctx.from.id);

  const user = await getUser(userId);
  user.started = true;
  await user.save();

  // ===== UNMUTE FLOW =====
  if (payload?.startsWith("unmute_")) {
    const groupId = payload.split("_")[1];
    const bio = await getBio(ctx.from.id);

    if (hasLink(bio)) {
      return ctx.reply("❌ Remove link from your bio first.");
    }

    try {
      await bot.api.restrictChatMember(Number(groupId), ctx.from.id, {
        permissions: { can_send_messages: true }
      });
    } catch {}

    return ctx.reply("✅ You are unmuted!");
  }

  const me = await bot.api.getMe();

  const kb = new InlineKeyboard()
    .url("➕ Add Me", `https://t.me/${me.username}?startgroup=true`)
    .row()
    .text("⚙️ Features", "features")
    .text("📊 Stats", "stats")
    .row()
    .text("💬 Support", "support");

  await ctx.reply(
`🥂 <b>GlassGuard PRO</b>

🔥 Bio Link Protection System
⚠️ Smart Warnings + Punishments
🌍 Global Ban System
📢 Broadcast Engine
💬 Live Support System

Add me to your group and stay protected.`,
    { parse_mode: "HTML", reply_markup: kb }
  );
});

// ================== UI CALLBACKS ==================
bot.callbackQuery("features", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
`⚙️ <b>Features</b>

• Bio Link Detection
• Auto Delete + Warn
• Mute / Ban System
• Force Join
• Global Ban Sync
• Leaderboard
• Livegram Support`,
    { parse_mode: "HTML" }
  );
});

bot.callbackQuery("stats", async (ctx) => {
  const users = await User.countDocuments();
  const groups = await Group.countDocuments();

  await ctx.answerCallbackQuery();
  await ctx.reply(`📊 Users: ${users}\n👥 Groups: ${groups}`);
});

bot.callbackQuery("support", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply("💬 Just send message here to contact owner.");
});

// ================== FORCE JOIN ==================
async function checkForceJoin(ctx, group) {
  if (!group.settings.forceJoinEnabled || !group.settings.forceJoinChannel) return false;

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

      await ctx.reply("🔐 Join channel to chat", { reply_markup: btn });
      return true;
    }
  } catch {}

  return false;
}

// ================== MAIN HANDLER ==================
bot.on("message", async (ctx) => {
  if (!ctx.from || ctx.from.is_bot) return;

  // ===== PRIVATE (LIVEGRAM) =====
  if (ctx.chat.type === "private") {
    if (String(ctx.from.id) === OWNER_ID) return;

    const fwd = await bot.api.forwardMessage(
      LOG_GROUP_ID,
      ctx.chat.id,
      ctx.message.message_id
    );

    await bot.api.sendMessage(
      LOG_GROUP_ID,
      `👤 ${ctx.from.id}`,
      { reply_to_message_id: fwd.message_id }
    );

    return;
  }

  // ===== GROUP =====
  const userId = String(ctx.from.id);
  const group = await getGroup(ctx.chat);
  const user = await getUser(userId);

  if (await checkForceJoin(ctx, group)) {
    await ctx.deleteMessage().catch(() => {});
    return;
  }

  if (group.settings.globalBanSync) {
    const gb = await GlobalBan.findOne({ userId });
    if (gb) {
      await ctx.banChatMember(ctx.from.id);
      return;
    }
  }

  const bio = await getBio(ctx.from.id);
  if (!hasLink(bio)) return;

  await ctx.deleteMessage().catch(() => {});

  let warn = user.warnings.find(w => w.groupId === String(ctx.chat.id));
  if (!warn) {
    warn = { groupId: String(ctx.chat.id), count: 0, graceUsed: false };
    user.warnings.push(warn);
  }

  if (!warn.graceUsed) {
    warn.graceUsed = true;
    await user.save();
    return ctx.reply("⌛ Remove link from bio");
  }

  warn.count++;
  await user.save();

  if (warn.count >= group.settings.maxWarnings) {
    await bot.api.restrictChatMember(ctx.chat.id, ctx.from.id, {
      permissions: { can_send_messages: false }
    });

    const me = await bot.api.getMe();
    const kb = new InlineKeyboard().url(
      "👉 Unmute",
      `https://t.me/${me.username}?start=unmute_${ctx.chat.id}`
    );

    return ctx.reply("🔇 Muted due to bio link", { reply_markup: kb });
  }

  ctx.reply(`⚠️ Warning ${warn.count}/${group.settings.maxWarnings}`);
});

// ================== SETTINGS ==================
bot.command("settings", async (ctx) => {
  if (ctx.chat.type === "private") return;

  const group = await getGroup(ctx.chat);

  const kb = new InlineKeyboard()
    .text(`Force Join: ${group.settings.forceJoinEnabled ? "ON" : "OFF"}`, "fj")
    .row()
    .text(`Global Ban: ${group.settings.globalBanSync ? "ON" : "OFF"}`, "gb");

  ctx.reply("⚙️ Settings", { reply_markup: kb });
});

bot.callbackQuery("fj", async (ctx) => {
  const g = await getGroup(ctx.chat);
  g.settings.forceJoinEnabled = !g.settings.forceJoinEnabled;
  await g.save();
  ctx.answerCallbackQuery("Force Join toggled");
});

bot.callbackQuery("gb", async (ctx) => {
  const g = await getGroup(ctx.chat);
  g.settings.globalBanSync = !g.settings.globalBanSync;
  await g.save();
  ctx.answerCallbackQuery("Global Ban toggled");
});

// ================== LEADERBOARD ==================
bot.command("top", async (ctx) => {
  if (ctx.chat.type === "private") return;

  const users = await User.find({});
  let arr = [];

  users.forEach(u => {
    const w = u.warnings.find(x => x.groupId === String(ctx.chat.id));
    if (w) arr.push({ id: u.userId, count: w.count });
  });

  arr.sort((a, b) => b.count - a.count);

  let text = "🏆 Top Violators\n\n";
  arr.slice(0, 10).forEach((u, i) => {
    text += `${i + 1}. ${u.id} — ${u.count}\n`;
  });

  ctx.reply(text);
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
    } catch {}
  }

  ctx.reply(`✅ Sent to ${sent}`);
});

// ================== OWNER REPLY ==================
bot.on("message", async (ctx) => {
  if (String(ctx.from.id) !== OWNER_ID) return;
  if (ctx.chat.id !== LOG_GROUP_ID) return;

  if (!ctx.message.reply_to_message) return;

  const text = ctx.message.reply_to_message.text;
  if (!text?.includes("👤")) return;

  const userId = text.split(" ")[1];

  await bot.api.copyMessage(userId, ctx.chat.id, ctx.message.message_id);
});

// ================== START ==================
bot.start();
console.log("🚀 Bot Started");
