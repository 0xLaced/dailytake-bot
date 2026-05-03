const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

// Brand color
const BRAND_COLOR = 0x4d8fff;

// Role names that bypass the once-per-day limit (case-insensitive)
const BYPASS_ROLES = ['team', 'admin', 'staff'];

// Allowed channel names — partial match, so "🌐 | crypto" still matches "crypto"
const ALLOWED_CHANNELS = [
  'discussion',
  'crypto',
  'politics',
  'sports',
  'esports',
  'finance',
  'weather',
  'tech',
  'culture',
];

// Data file — mount a Railway Volume at /app/data for persistence across redeploys
const DATA_FILE = path.join(__dirname, 'data', 'takes.json');

// ─── Data Helpers ─────────────────────────────────────────────────────────────
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify({ totalTakes: 0, dailyLog: {} }, null, 2));
    }
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    console.error('Error loading data:', err);
    return { totalTakes: 0, dailyLog: {} };
  }
}

function saveData(data) {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error saving data:', err);
  }
}

function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
}

function hasSubmittedToday(data, userId) {
  const today = getTodayKey();
  return !!(data.dailyLog[today]?.[userId]);
}

function logTake(data, userId, username, channelName, takeText) {
  const today = getTodayKey();
  if (!data.dailyLog[today]) data.dailyLog[today] = {};
  data.dailyLog[today][userId] = {
    username,
    channel: channelName,
    take: takeText,
    timestamp: new Date().toISOString(),
  };
  data.totalTakes = (data.totalTakes || 0) + 1;

  // Prune entries older than 30 days
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  for (const dateKey of Object.keys(data.dailyLog)) {
    if (new Date(dateKey) < cutoff) delete data.dailyLog[dateKey];
  }
}

// ─── Register Slash Command ────────────────────────────────────────────────────
async function registerCommands() {
  const command = new SlashCommandBuilder()
    .setName('dailytake')
    .setDescription('Log your Polymarket prediction play of the day')
    .addStringOption(option =>
      option
        .setName('prediction')
        .setDescription('Your take — plain text, a Polymarket link, market name, analysis, anything')
        .setRequired(true)
        .setMaxLength(1000)
    )
    .addAttachmentOption(option =>
      option
        .setName('image')
        .setDescription('Optional: attach a screenshot, chart, or market image')
        .setRequired(false)
    );

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body: [command.toJSON()],
    });
    console.log('Slash commands registered!');
  } catch (err) {
    console.error('Failed to register commands:', err);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match ? match[0] : null;
}

function isImageAttachment(attachment) {
  if (!attachment) return false;
  const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
  const url = attachment.url.toLowerCase().split('?')[0];
  return imageExts.some(ext => url.endsWith(ext)) || attachment.contentType?.startsWith('image/');
}

function bypassLabel(memberRoles) {
  for (const role of ['admin', 'team', 'staff']) {
    if (memberRoles.some(r => r.name.toLowerCase() === role)) return role;
  }
  return 'staff';
}

// ─── Bot Client ───────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'dailytake') return;

  const channel = interaction.channel;
  const member = interaction.member;
  const prediction = interaction.options.getString('prediction');
  const attachment = interaction.options.getAttachment('image') ?? null;

  // ── 1. Validate channel ────────────────────────────────────────────────────
  const channelSlug = channel.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isAllowedChannel = ALLOWED_CHANNELS.some(allowed =>
    channelSlug.includes(allowed.replace(/[^a-z0-9]/g, ''))
  );

  if (!isAllowedChannel) {
    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('Wrong Channel')
          .setDescription(
            `Daily takes must be submitted in one of these channels:\n\n` +
            ALLOWED_CHANNELS.map(c => `**#${c}**`).join('  ·  ')
          ),
      ],
      ephemeral: true,
    });
  }

  // ── 2. Check for bypass role ───────────────────────────────────────────────
  const memberRoles = [...member.roles.cache.values()];
  const hasBypassRole = BYPASS_ROLES.some(roleName =>
    memberRoles.some(r => r.name.toLowerCase() === roleName.toLowerCase())
  );

  // ── 3. Rate-limit non-bypass users ────────────────────────────────────────
  const data = loadData();

  if (!hasBypassRole && hasSubmittedToday(data, member.id)) {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const unixTimestamp = Math.floor(tomorrow.getTime() / 1000);

    return interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff9900)
          .setTitle('Already Submitted Today')
          .setDescription(
            `You've already logged your daily take!\nCome back <t:${unixTimestamp}:R> for your next one.`
          )
          .setFooter({ text: 'One take per day · Resets at midnight UTC' }),
      ],
      ephemeral: true,
    });
  }

  // ── 4. Log the take ────────────────────────────────────────────────────────
  const takeRecord = attachment ? `${prediction} [image: ${attachment.url}]` : prediction;
  logTake(data, member.id, member.user.username, channel.name, takeRecord);
  saveData(data);

  const totalTakes = data.totalTakes;
  const roleLabel = hasBypassRole ? bypassLabel(memberRoles) : null;

  // ── 5. Build success embed ─────────────────────────────────────────────────
  const firstUrl = extractUrl(prediction);

  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('Daily Take Logged!')
    .setDescription(prediction)
    .addFields(
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Take Counter', value: `**#${totalTakes.toLocaleString()}**`, inline: true },
      {
        name: hasBypassRole ? 'Submitted by' : 'Submitted by',
        value: `<@${member.id}>`,
        inline: true,
      }
    )
    .setTimestamp()
    .setFooter({
      text: hasBypassRole
        ? `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} · Unlimited takes`
        : 'Verified · One take per day · Resets midnight UTC',
    });

  // If prediction text contains a URL, make the embed title clickable
  if (firstUrl) {
    embed.setURL(firstUrl);
  }

  // If they attached an image, render it inside the embed
  if (attachment && isImageAttachment(attachment)) {
    embed.setImage(attachment.url);
  } else if (attachment) {
    embed.addFields({ name: 'Attachment', value: `[View file](${attachment.url})`, inline: false });
  }

  await interaction.reply({ embeds: [embed] });
});

// ─── Start ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
