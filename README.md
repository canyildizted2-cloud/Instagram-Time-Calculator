# 📊 Instagram Usage Time Analyzer

Ever wondered **how much of your life** went into Instagram? Upload your official Instagram data export (ZIP) and get a complete breakdown of your usage: estimated hours, sessions, active days, monthly trends, hourly habits, devices and login locations. Everything is computed **100 percent locally in your browser**. No server, no uploads, no tracking. 🔒

I built this because Instagram settings show no total usage metric anywhere. The export file you download from accounts.instagram.com has the data, this tool turns it into minutes, hours and days you can actually read.

![Homepage](README%20pngs/homepage.png)

## ✨ Features

Every screenshot below was generated with the built in sample dataset, so you can preview each feature before uploading your own export.

### 📊 Usage Statistics

The headline dashboard: total estimated hours converted to days, counted sessions, active days with percentage, daily average, total activity entries and your full activity date range. Everything sits on one glanceable KPI row, and a separate membership card shows how many days have passed since you signed up.

![Usage Statistics](README%20pngs/statiscits%20example.png)

### 📅 Estimated Monthly Usage

A color coded bar chart of your estimated usage per month, from your very first activity to today. Quiet months stay gray, heavy months turn yellow, orange and red. The chart area scrolls horizontally and supports mouse wheel zoom, with an average reference line so you can compare every month to your overall average.

![Monthly Usage Chart](README%20pngs/monthly%20usage%20example.png)

### 🕐 Hourly Distribution

See when during the day you actually use Instagram, split into all 24 hours. Each bar is color coded to match that hour of a reference day photo. Filter the chart by last week, last month, last 3 months, last year or all time, and choose between hourly or 6 hour block grouping from the gear menu.

![Hourly Distribution](README%20pngs/hourly%20usage%20example.png)

### 📆 Yearly Detailed Breakdown

A year by year table: total logged events, counted sessions, active days, estimated hours and the day equivalent per year. Perfect for spotting which year you lived on the platform and which year you barely opened the app.

![Yearly Detailed Breakdown](README%20pngs/yearly%20detailed%20usage%20example.png)

### 📱 Device Distribution

A doughnut chart of every device that ever logged into your account, with estimated hours and percentage share per device. If the same model appears from multiple IPs, those are merged into one entry. Watching your phone history from 2015 to today is a nostalgia trip on its own.

### 🌍 Location Distribution

A table of where you pressed login, based on IP addresses in your export. City resolution is opt in: nothing is sent anywhere until you click the Resolve IPs to Cities button, and results are cached locally so reanalyzing the same ZIP makes zero repeat requests.

![Device and Location](README%20pngs/device%20and%20location%20example.png)

### 🖥️ Live Terminal View

Watch the ZIP being scanned source by source in a hacker style overlay: each data file, line count and timestamp as it is parsed. Purely cosmetic, completely mesmerizing.

### 📝 Markdown Report Export

Download the full analysis as a single clean .md file: KPI table, monthly breakdown, yearly breakdown, hourly table, device and location distributions. Ready to paste into your notes or share with a friend.

### 🎭 Sample Data Mode

No export at hand? Hit the sample data button and the app runs instantly on a built in demo dataset spanning 2015 to today with realistic usage patterns. All screenshots in this README come from that dataset.

## 🚀 Installation

No build step, no dependencies to install. It is a static page. Requirement: a modern browser, Python 3 only if you want the auto opening local server.

```bash
# Option 1: run the local server (opens your browser automatically)
python run_app.py

# Option 2: just double click index.html, it even works offline
```

## ⚡ Quick Start

1️⃣ Download your data from Instagram:

```text
Accounts Center > Your information and permissions > Download your information
Format: JSON
Date range: All time
```

Old accounts can take 10 minutes or more to export, the file arrives by email.

2️⃣ Drag the ZIP you received (instagram-username-date.zip) straight onto the drop zone, no extraction needed.

3️⃣ Read your results:

```text
Estimated Total: 2,487 hours, about 103 days
Counted Sessions: 19,824
Active Days: 1,473 out of 2,403 days, 61.3 percent
Top Month: May 2020 (135 hours)
```

## 🧮 How the Time Estimation Works

Instagram does not give you screen time, so the app reconstructs it from activity timestamps:

- Gap of 10 minutes or less between two events: same session, the elapsed time is summed
- Gap longer than 10 minutes: session ends, the gap is not counted
- A known login and logout pair: the real session duration is used
- Logins, likes, comments, story interactions, saved items, searches and sent messages all act as checkpoints on one timeline

## ⚠️ Status and Known Limitations

Actively developed, alpha stage. Known limits:

- Only JSON format exports are supported, HTML exports are not
- Time is an estimate: real screen on time can be 10 to 25 percent higher
- First and last logins anchor the date range, entries outside those years are ignored
- Location resolution is IP based, not real GPS position

## 📄 License

MIT. See the LICENSE file for details. This software has no relation to Meta. Instagram is a trademark of Meta Platforms, Inc.
