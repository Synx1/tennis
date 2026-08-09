# Tennis Stats Bot

Discord bot for tennis match analysis, statistics, and live match tracking.

## Features

- **Player Comparison** - Full statistical comparison of two players with prediction
- **Player Profiles** - Detailed set-by-set statistics and recent form
- **Head-to-Head** - Historical matchup records between players
- **Live Matches** - Real-time match listings from Kalshi with odds
- **Prediction Model** - Statistical model trained on historical data (64.1% accuracy vs market's 67.6%)

## Data Sources

- **Set-level history**: tennis-data.co.uk (ATP/WTA match results 2020-2026)
- **Point-level data**: Match Charting Project (aces, break points)
- **Live fixtures**: Kalshi API (KXATPMATCH / KXWTAMATCH series)

## Commands

- `/compare player1:Sinner player2:Alcaraz [tour:atp] [surface:Hard]` - Compare two players
- `/player name:Swiatek [tour:wta] [surface:Clay]` - Get player profile
- `/h2h player1:Djokovic player2:Nadal [tour:atp]` - Head-to-head history
- `/matches [all:true]` - Show live and upcoming matches
- `/accuracy [tour:atp]` - Model performance metrics

## Statistics Tracked

### Set-Level
- Win rates by set (1st, 2nd, 3rd)
- Conditional records (win after losing set 1, etc.)
- Set 3 performance after winning/losing set 2
- Surface-specific records (Hard, Clay, Grass, Carpet)
- Recent form (last 10 matches)
- Current streaks

### Point-Level (when available)
- Ace splits and match outcomes
- Break potential per match
- Break potential per return game
- Conceded break points (server vulnerability)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variable:
```bash
export TENNIS_BOT_TOKEN=your_discord_token
```

3. Run the bot:
```bash
npm start
```

## Architecture

- `tennis-bot.js` - Main Discord client and command handlers
- `src/tennisdata.js` - Fetch and cache match history from tennis-data.co.uk
- `src/tennisstats.js` - Statistical analysis and profile generation
- `src/tennispredict.js` - Prediction model and backtesting
- `src/tennislive.js` - Live match fixtures from Kalshi
- `src/tenniscore.js` - Point-level data from Match Charting Project
- `src/tennis.js` - Whale scanner (Polymarket) - separate feature
- `src/kalshi.js` - Kalshi API client with throttling

## Data Storage

- `data/tennis/` - Cached ATP/WTA match history by year
- `data/tennis-mcp/` - Cached point-level charting data

## Model Performance

Measured on 4,617 historical matches with no lookahead:
- **Model accuracy**: 64.1%
- **Market accuracy**: 67.6%
- **Model log loss**: 0.6428
- **Market log loss**: 0.5922

The model is presented as an explanation tool, not as an edge over market prices.

## Notes

- Seasons are cached locally and refreshed daily
- Point-level data requires joining two sources with different name formats
- Coverage is partial for point-level statistics (join success varies by player)
- Historical data spans 2020-2026 (configurable via `CAREER_FROM`/`CAREER_TO`)
