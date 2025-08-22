<div align="center">
  <img id="top" src="https://placeholder.com/i+am+dead+inside" width="100%" alt="PreWatch Banner">

# 🔍 PreWatch: Scene Release Monitoring Made Easy 🚀

  <p>
    <a href="https://discord.gg/Q3ZhdRJ"><img src="https://img.shields.io/discord/495602800802398212.svg?colorB=5865F2&logo=discord&logoColor=white&style=for-the-badge" alt="Discord"></a>
    <a href="https://github.com/Valhalla-Development/PreWatch/stargazers"><img src="https://img.shields.io/github/stars/Valhalla-Development/PreWatch.svg?style=for-the-badge&color=yellow" alt="Stars"></a>
    <a href="https://github.com/Valhalla-Development/PreWatch/network/members"><img src="https://img.shields.io/github/forks/Valhalla-Development/PreWatch.svg?style=for-the-badge&color=orange" alt="Forks"></a>
    <a href="https://github.com/Valhalla-Development/PreWatch/issues"><img src="https://img.shields.io/github/issues/Valhalla-Development/PreWatch.svg?style=for-the-badge&color=red" alt="Issues"></a>
    <a href="https://github.com/Valhalla-Development/PreWatch/blob/main/LICENSE"><img src="https://img.shields.io/github/license/Valhalla-Development/PreWatch.svg?style=for-the-badge&color=blue" alt="License"></a>
    <br>
    <a href="https://app.codacy.com/gh/Valhalla-Development/PreWatch/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade"><img src="https://img.shields.io/codacy/grade/02150b57497c4442a76aded7ac535ef5?style=for-the-badge&color=brightgreen" alt="Codacy"></a>
    <a href="#"><img src="https://img.shields.io/badge/Powered%20by-discord.js-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Powered by discord.js"></a>
    <a href="#"><img src="https://img.shields.io/badge/Made%20with-TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="Made with TypeScript"></a>
  </p>

  <p><em>Monitor scene releases in real-time and get instant Discord notifications for your favorite content!</em></p>
</div>

---
## 🌟 Welcome to PreWatch!

PreWatch is a Discord bot that monitors scene releases from the [PreDB](https://predb.net/) in real-time. Subscribe to search queries and get instant notifications when matching releases are found, built with [discordx](https://discord-x.js.org/) and [discord.js v14](https://discord.js.org/).

## 🎮 Features That Power PreWatch

<table>
  <tr>
    <td width="50%">
      <h3>🔍 Smart Query Monitoring</h3>
      <p>Subscribe to search queries and get notified when matching scene releases appear.</p>
    </td>
    <td width="50%">
      <h3>⚡ Real-time WebSocket Stream</h3>
      <p>Live connection for instant release notifications as they happen.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🎯 Intelligent Matching</h3>
      <p>Fuzzy matching algorithm optimized for scene releases with similarity detection.</p>
    </td>
    <td width="50%">
      <h3>💾 Lightweight Database</h3>
      <p>Keyv with SQLite backend for persistent subscription storage without SQL complexity.</p>
    </td>
  </tr>
  <tr>
    <td width="50%">
      <h3>🎨 Rich Discord Components</h3>
      <p>Beautiful Discord Components for all interactions with buttons and styled messages.</p>
    </td>
    <td width="50%">
      <h3>🔔 Flexible Notifications</h3>
      <p>Choose between DM or channel notifications with one-click unsubscribe buttons.</p>
    </td>
  </tr>
</table>

## 🚀 Requirements

- [Bun](https://bun.sh/) - Fast JavaScript runtime
- [Discord Bot Application](https://discord.com/developers/applications) with bot token
- Access to [Predb.ovh API](https://predb.club/api/v1) (default endpoint)

## 🛠️ Setup Guide

1. [Download](https://github.com/Valhalla-Development/PreWatch/releases) the latest release (click on 'Source code (zip)').

2. Extract and move the files to your desired location.

3. Install Bun:
   - Mac/Linux:
     ```bash
     curl -fsSL https://bun.sh/install | bash
     ```
   - Windows:
     ```powershell
     powershell -c "irm bun.sh/install.ps1 | iex"
     ```

4. Navigate to your project folder:
    ```bash
    cd /path/to/your/extracted/source
    ```

5. Rename `.env.example` to `.env` and configure your settings:
   - **Required:** Bot token, API URL, notification channel/mode
   - [Bot Token Guide](https://github.com/reactiflux/discord-irc/wiki/Creating-a-discord-bot-&-getting-a-token)
   - [Channel ID Guide](https://support.discordapp.com/hc/en-us/articles/206346498-Where-can-I-find-my-User-Server-Message-ID-)

6. Install dependencies:
    ```bash
    bun install
    ```

7. Start the bot:
    ```bash
    bun start
    ```

## 🎯 Commands

- `/add <query>` - Subscribe to a search query for release notifications
- `/list` - View and manage your active subscriptions  
- `/help` - Display all available commands
- `/ping` - Check bot status and performance

## 📸 Screenshots

<!-- ValhallaDevelopment zipline instance is currently undergoing maintenance therefore these are placeholder links -->
<div align="center">
  <table>
    <tr>
      <td align="center" width="50%">
        <strong>Adding Subscriptions</strong><br>
        <img src="https://placeholder.com/400x300/0066cc/ffffff?text=Add+Command" width="400px" alt="Add Command">
      </td>
      <td align="center" width="50%">
        <strong>Release Notifications</strong><br>
        <img src="https://placeholder.com/400x300/cc6600/ffffff?text=Release+Notification" width="400px" alt="Release Notification">
      </td>
    </tr>
    <tr>
      <td align="center" width="50%">
        <strong>Subscription Management</strong><br>
        <img src="https://placeholder.com/400x300/006600/ffffff?text=List+Command" width="400px" alt="List Command">
      </td>
      <td align="center" width="50%">
        <strong>Similarity Detection</strong><br>
        <em>Smart detection prevents duplicate subscriptions</em><br>
        <img src="https://placeholder.com/400x300/cc3300/ffffff?text=Similarity+Check" width="400px" alt="Similarity Check">
      </td>
    </tr>
  </table>
</div>

## 🤝 Contributing

We welcome contributions to improve PreWatch! If you'd like to contribute:

1. Fork the repository
2. Create a new branch for your feature or bug fix:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. Make your changes and commit them with a clear, descriptive message:
   ```bash
   git commit -m 'Add feature: brief description of your changes'
   ```
4. Push your changes to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
5. Open a Pull Request against the main repository's `main` branch

Please ensure your code follows the existing patterns and include clear descriptions in your Pull Request. Focus on performance and user experience improvements.

## 📜 License

This project is licensed under the GPL-3.0 License - see the LICENSE file for details. (It's mostly "Share the love, and keep it open!")

## 🙏 Acknowledgements

- [PredDB](https://predb.net/) for the awesome scene release tracking
- [discord.js](https://discord.js.org/) for the powerful Discord API wrapper
- [discordx](https://discord-x.js.org/) for the decorator-based command framework
- [Bun](https://bun.sh/) for the blazing fast JavaScript runtime
- [Keyv](https://keyv.org/) for simple key-value storage

## 📬 Support & Community

Got questions or need help? Join our [Discord server](https://discord.gg/Q3ZhdRJ) for support and to connect with other PreWatch users!

---

<div align="center">

💻 Crafted with ❤️ by [Valhalla-Development](https://github.com/Valhalla-Development)
Built on the [ValkyrieCore](https://github.com/Valhalla-Development/ValkyrieCore) Discord bot template.

[🐛 Spotted an issue?](https://github.com/Valhalla-Development/PreWatch/issues/new?assignees=&labels=bug&projects=&template=bug_report.yml&title=%5BBUG%5D+Short+Description) | [💡 Got an idea?](https://github.com/Valhalla-Development/PreWatch/issues/new?assignees=&labels=enhancement&projects=&template=feature_request.yml&title=%5BFeature%5D+Short+Description) | [🤔 Need help?](https://discord.gg/Q3ZhdRJ)

<a href="#top">🔝 Back to Top</a>
</div>
