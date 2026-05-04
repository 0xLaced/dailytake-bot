const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
} = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

// ─── Config ───────────────────────────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const BRAND_COLOR = 0x4d8fff;

// Role names that bypass the once-per-day limit (case-insensitive)
const BYPASS_ROLES = ['team', 'admin', 'staff'];

// Allowed channel names — partial match so "🌐 | crypto" still matches "crypto"
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

// ─── Supabase Client ──────────────────────────────────────────────────────────
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Database Helpers ─────────────────────────────────────────────────────────
function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD" UTC
}

async function hasSubmittedToday(userId) {
  const today = getTodayKey();
  const { data, error } = await supabase
    .from('daily_takes')
    .select('id')
    .eq('user_id', userId)
    .eq('date', today)
    .maybeSingle();

  if (error) { console.error('hasSubmittedToday error:', error); return false; }
  return !!data;
}

async function insertTake({ userId, username, channelName, prediction, imageUrl, hasBypassRole }) {
  const { error } = await supabase.from('daily_takes').insert({
    user_id: userId,
    username,
    channel: channelName,
    prediction,
    image_url: imageUrl || null,
    has_bypass_role: hasBypassRole,
    date: getTodayKey(),
    submitted_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function getTotalTakes() {
  const { count, error } = await supabase
    .from('daily_takes')
    .select('*', { count: 'exact', head: true });
  if (error) { console.error('getTotalTakes error:', error); return 0; }
  return count;
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
  if (!hasBypassRole && await hasSubmittedToday(member.id)) {
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

  // ── 4. Insert take into Supabase ───────────────────────────────────────────
  await interaction.deferReply(); // gives us time for the async DB write

  try {
    await insertTake({
      userId: member.id,
      username: member.user.username,
      channelName: channel.name,
      prediction,
      imageUrl: attachment?.url ?? null,
      hasBypassRole,
    });
  } catch (err) {
    console.error('Failed to insert take:', err);
    return interaction.editReply({
      embeds: [
        new EmbedBuilder()
          .setColor(0xff4444)
          .setTitle('Something went wrong')
          .setDescription('Your take could not be saved. Please try again in a moment.'),
      ],
    });
  }

  const totalTakes = await getTotalTakes();
  const roleLabel = hasBypassRole ? bypassLabel(memberRoles) : null;

  // ── 5. Build success embed ─────────────────────────────────────────────────
  const embed = new EmbedBuilder()
    .setColor(BRAND_COLOR)
    .setTitle('🔥 Daily Take Logged!')
    .setDescription(prediction)
    .addFields(
      { name: 'Channel', value: `<#${channel.id}>`, inline: true },
      { name: 'Take Counter', value: `**#${totalTakes.toLocaleString()}**`, inline: true },
      { name: 'Submitted by', value: `<@${member.id}>`, inline: true }
    )
    .setTimestamp()
    .setFooter({
      text: hasBypassRole
        ? `${roleLabel.charAt(0).toUpperCase() + roleLabel.slice(1)} · Unlimited takes`
        : 'Verified · One take per day · Resets midnight UTC',
    });

  if (attachment && isImageAttachment(attachment)) {
    embed.setImage(attachment.url);
  } else if (attachment) {
    embed.addFields({ name: 'Attachment', value: `[View file](${attachment.url})`, inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
});

// ─── Start ────────────────────────────────────────────────────────────────────
client.login(TOKEN);
