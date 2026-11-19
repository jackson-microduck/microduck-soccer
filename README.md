# Microduck League

Online 3v3-style soccer for Jackson and friends. Everyone plays as **Microduck**, the little biped robot from [Pollen Robotics](https://github.com/pollen-robotics/microduck_rl). Open the site on a computer, phone, or tablet, make a username, and kick a ball that sticks to your duck until someone slide-tackles it away.

The robot meshes are **CC BY-NC-SA 4.0**. This game is a non-commercial fan project. Do not charge money for it or put ads on it. See `NOTICE.md`.

## Play on a Mac

You need **Node.js 22.5 or newer** (the current Node 22 LTS is fine). The game stores accounts with Node's built-in SQLite, so `npm install` does not compile anything. That works on Apple Silicon (`darwin-arm64`) and Intel Macs (`darwin-x64`).

1. Install Node if `node -v` is missing or older than 22.5. On Apple Silicon, download the **macOS ARM64** installer from [https://nodejs.org](https://nodejs.org) (the 22 LTS button), or run `brew install node@22`.
2. In Terminal:

```bash
git clone https://origin.cursor.com/git/jackson-carpenter/tmp-4c994e70bd034e3d.git
cd tmp-4c994e70bd034e3d
node -v
npm install
npm start
```

3. Open [http://127.0.0.1:8741](http://127.0.0.1:8741).

`node -v` should print `v22.5` or higher before `npm install`. Leave the Terminal window open while you play. Stop the game with Control-C.

Friends on the same Wi-Fi can open `http://THAT-MAC-IP:8741`. Find the IP in System Settings → Network. If a phone cannot connect, allow incoming connections for Node when macOS asks.

Accounts are saved in `data/league.sqlite` in this folder. Older save files still open. New club lists and ranks are added the first time the game starts.

A 3v3 can be played with goalies or without. When the goalie has the ball, a power bar slides in the scoreboard. Press Enter on a laptop, or Stop on a phone, to kick with that power. One account can own up to 8 clubs and join as many as it likes. The club owner sets the match, members press Ready, and owners can challenge another club. Ranks lists the top clubs and the top players, and it always shows your own place. Computer ducks are not on the ranks.

## Play on your computer

You need **Node.js 22.5** or newer. Check with `node -v`.

```bash
npm install
npm start
```

Then open [http://127.0.0.1:8741](http://127.0.0.1:8741).

Friends on the **same Wi-Fi** can play too. On the computer running the game, find its IP address (`ipconfig` on Windows, `ip addr` or System Settings on a Mac) and open `http://THAT-IP:8741` on the other devices. If a phone cannot connect, allow Node through the computer's firewall.

Accounts live in `data/league.sqlite`. They stay put when you stop and start the game on that computer.

## Put it on the internet for free

You will need two free accounts. A parent email is enough.

1. A **GitHub** account: [github.com/signup](https://github.com/signup)
2. A **Render** account: [render.com](https://render.com) (sign up with GitHub)

The Microduck model cannot be used commercially, so leave the site free.

### Put the code on GitHub

1. On GitHub, create a new repository. Name it `microduck-league`. Leave it empty (no README, no license file). Private is fine.
2. On the computer that has this project, from this folder:

```bash
git remote add github https://github.com/YOUR-NAME/microduck-league.git
git push -u github main
```

GitHub will ask you to log in. Replace `YOUR-NAME` with the GitHub username.

### Start it on Render

1. In Render, choose **New +** → **Web Service**.
2. Connect the `microduck-league` repository.
3. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. You do not need any API keys. Render sets `PORT` for you.
5. Click **Create Web Service**. When the log says the service is live, open the `*.onrender.com` address Render shows.

The free server sleeps after nobody has visited for a while. The first open after that can take about a minute.

**Accounts on the free plan:** Render's free disk is wiped when the app restarts or goes to sleep for a long time, so usernames can disappear. Playing on a family computer (the steps above) keeps accounts. To keep them online, add a paid Render disk and set the environment variable `DB_PATH` to a file on that disk, for example `/var/data/league.sqlite`.

## How a match works

- Sign up with a username and password. No email. Passwords are stored scrambled. The player directory shows usernames, ranks, and stats only.
- Make a club, share its code, or invite a friend from the directory. They accept before they join.
- **Play vs Bots** from the match screen. Pick 1v1, 2v2, or 3v3, then Easy, Medium, or Hard. Computer ducks fill the empty spots on your team and the other team. They chase, pass, dribble, shoot, sprint, spin, and slide. In 3v3 their goalie dives. Bot matches do not change your rating. In 3v3 you can tick "I will play goalie" before you start.
- Play **1v1**, **2v2**, or **3v3** against friends too. Queue for a ranked match, or create a private room. Club matches can invite clubmates. Each invitee gets an in-app note (and a browser alert, if they allowed it) that lists the other people invited.
- Pick a **3 minute** or **5 minute** match before you queue or create the room.
- The ball **locks** to you when you take it. Opponents **slide** to knock it loose. A missed slide stuns you for a moment. **Spin** (P, or the Spin button) is a short dodge: if a slide arrives during the spin, it misses. Both moves have a cooldown.
- **Sprint** is Shift, or hold the Sprint button. A stamina bar drains while you sprint and refills when you stop. Sprinting with the ball is slower.
- **Goalies only in 3v3.** One duck per side can dive and catch. 1v1 and 2v2 have no goalies.
- Goals are about two to three ducks wide and one duck tall. After a goal the scoring side gets **8 seconds** to celebrate (spin, quack, head bob, sit-and-stand, roller glide). The other side waits, then it is kickoff.
- Rating goes up and down from the result, and goals and assists change it further. Ranked queues balance teams by rating. Practice ducks fill a private room but do not change rating.

### Controls

| Action | Keyboard | Touch |
| --- | --- | --- |
| Move | W A S D or arrows | Joystick |
| Sprint | Hold Shift | Hold Sprint |
| Kick | K or Space | Kick |
| Pass | J | Pass |
| Slide tackle | C | Slide |
| Dribble spin | P | Spin |
| Goalie dive | G | Dive (goalies, 3v3) |
| Celebrate | 1 spin, 2 quack, 3 bob, 4 sit, 5 glide | Those buttons after a goal |

The same list is on the Controls button and the **?** button during a match.

## Tests

```bash
npm test
```

That checks ball lock, slide tackles, the spin dodge, sprint and stamina, 8-second celebrations, goalies only in 3v3, rating, and a scripted two-browser 1v1 plus full 2v2 and 3v3 rooms.
