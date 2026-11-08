# Setting up AI marking

TypePDF can mark a paper three ways. All three end the same way: the marks appear on the paper like a teacher's red pen.

| | What you press | Who marks it | Cost |
|---|---|---|---|
| **Mark with AI** | ✓ Marks → ✨ Mark with AI | The best free AI that's available right now (one of the keys below) | Free; stops at each service's free limit |
| **Mark with Claude** | ✓ Marks → Mark with Claude | Claude, in your own Claude account, through the TypePDF connector | Your Claude plan |
| **Export for AI** | Export for AI → Download for Claude | Any AI you drop the files into | Whatever that AI costs |

## 1. Free keys for "Mark with AI"

Paste each key in **TypePDF → Export for AI → AI settings…** (admin only). Then press **Test**. Keys stay on the TypePDF server: they're never shown again, and never sent to anyone's browser.

**You don't need to choose models.** Each provider is asked which models it offers right now (rechecked every few hours), and the best ones still on its free tier are used. Leave the Models box empty unless you want particular ones. **Test** shows which models it's using and what each one said.

Mark with AI tries the providers in the order below. It moves to the next one when a provider is at its limit, gives an error, or sends back something that isn't a proper marking. You only need one, but more means it almost never runs out.

None of these charge you **as long as you don't add a card or billing to that account**. Without billing they just refuse requests at the limit, and TypePDF moves on to the next.

1. **Google Gemini**: the best of the free ones (it reads handwriting and diagrams well).
   - Go to <https://aistudio.google.com/apikey>, sign in with a Google account, and press **Create API key**.
   - Don't enable billing on that Google Cloud project.
   - TypePDF asks Gemini which models it has now and uses the newest Pro, then the newest Flash models, then Flash-Lite. Pro is often not on the free tier, so it's tried and skipped. If Google says a model has been retired and names its replacement, the replacement is tried next.
   - On the free tier, Google may use what you send to improve its products.
2. **GitHub Models**: free with any GitHub account.
   - Go to <https://github.com/settings/personal-access-tokens/new> and create a fine-grained token.
   - Under **Permissions → Account permissions → Models**, choose **Read-only**. Copy the token.
   - The daily limits are small, and long papers can be too big for its free requests. TypePDF then just moves on.
3. **OpenRouter**:
   - Go to <https://openrouter.ai/keys> and create a key. TypePDF reads OpenRouter's current model list and only ever uses models that cost nothing (about 50 requests a day). OpenRouter regularly moves free models to paid, and those are skipped automatically.
   - **Don't add credit** to the account.
4. **Groq**:
   - Go to <https://console.groq.com/keys>, sign up, and press **Create API Key**. No card is needed.
5. **Any other OpenAI-compatible API**: for other services with a free tier, such as Cerebras, NVIDIA NIM, SambaNova or Together's free models.
   - Put the service's `…/chat/completions` address, your key and a model name.
   - A maintained list of free APIs: <https://github.com/cheahjs/free-llm-api-resources>.
6. **Cloudflare Workers AI**: no key, since it's built into the TypePDF Worker. Off until you tick **Use**.
   - Only switch it on if your Cloudflare **Workers plan is Free**. Then it stops at the daily allowance.
   - On the paid Workers plan, use beyond the allowance is billed.
   - It only reads typed answers (no images), and it's the weakest marker here.

Optional, and not free: **Claude (Anthropic API)**. If you add a key it's tried first, because it marks best.
- Create the key at <https://console.anthropic.com/settings/keys>.
- Buy a small amount of prepaid credit and leave **auto-reload off**. It then simply stops when the credit's used up, so it can never charge more.

You can also set keys as Worker secrets instead of pasting them into TypePDF. In the Cloudflare dashboard, open the Worker, then **Settings → Variables and Secrets**. The names are `GEMINI_API_KEY`, `GITHUB_MODELS_TOKEN`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `CUSTOM_AI_KEY` (with `CUSTOM_AI_URL`) and `ANTHROPIC_API_KEY`.

### Limits for other accounts

Anyone signed in can press Mark with AI. Each account gets **12 markings and 80 chat messages a day** (the admin gets 60 and 300), so nobody can use up your free allowances.

## 2. Connecting Claude ("Mark with Claude")

Claude.ai can't be shown inside another website (it blocks being embedded), and other websites can't use your Claude subscription. So TypePDF works the other way round: it becomes a **connector** that Claude can use. You set it up once:

1. In TypePDF: **Export for AI → Connect Claude…** and copy your connector link. It's private, so treat it like a password. **Reset the link** makes the old one stop working.
2. In Claude (claude.ai, the desktop app or the mobile app): **Settings → Connectors → Add custom connector**. Name it `TypePDF`, paste the link and add it. Custom connectors depend on your Claude plan; the free plan may allow only one.
3. In a chat, check **TypePDF** is switched on in the tools/connectors menu. The first time Claude uses it, allow its tools.

Then, on any paper: **✓ Marks → Mark with Claude**.
- TypePDF prepares the paper (your answers, your handwriting, and a picture of every page) and opens Claude beside it, with the request already typed in.
- On a computer it opens a window on the right half of the screen. On an iPad, put Claude and TypePDF side by side with Split View.
- If the message box is empty, paste: the request is on your clipboard too.
- Press send. Claude fetches the paper, marks it and sends the marks back, and they appear on the paper in TypePDF as soon as it does.

Claude's connector tools:

| tool | |
|---|---|
| `list_papers` | your papers, newest first, and which are ready to mark |
| `get_paper_for_marking` | the instructions, your answers and your handwriting |
| `get_page` | a picture of any page |
| `get_marking` | the marking already on a paper, so you can talk it through in Claude ("why did I lose marks on 7(b)?") |
| `submit_marking` | puts the marks on the paper |

## 3. Drop links (for any AI that can make web requests)

Every Export for AI bundle (while you're signed in) includes a private **drop link** in its instructions.
- An AI that can make web requests can POST the marking JSON to that link, and it appears on your paper straight away, with no copying.
- That covers Claude with code execution and network access allowed for your TypePDF address, Claude Code, and other agents.
- An AI that can't make web requests just gives you the file, and you import it in **✓ Marks → Import a marking** as before.
- Drop links last 30 days and only work for that one paper.

## 4. Asking about your marks

Once a paper is marked, the Marks panel has a chat: "why did I lose a mark on 7(b)?", "show me a full-mark answer". It's answered by the same free AIs, which see the paper, your answers and the marking. **Talk it through with Claude instead** opens Claude, which reads the marking through the connector.
