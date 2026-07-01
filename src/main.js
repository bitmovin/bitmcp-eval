import express from "express";
import { Octokit } from "@octokit/rest";

const app = express();
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN }); // token optional for public repos

// GET /release/:owner/:repo/latest
app.get("/release/:owner/:repo/latest", async (req, res) => {
  const { owner, repo } = req.params;
  try {
    const { data } = await octokit.rest.repos.getLatestRelease({ owner, repo });
    res.json({
      tag: data.tag_name,
      name: data.name,
      publishedAt: data.published_at,
      url: data.html_url,
      assets: data.assets.map((a) => ({ name: a.name, download: a.browser_download_url })),
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// GET /release/:owner/:repo/:tag  (fetch a specific release by tag)
app.get("/release/:owner/:repo/:tag", async (req, res) => {
  const { owner, repo, tag } = req.params;
  try {
    const { data } = await octokit.rest.repos.getReleaseByTag({ owner, repo, tag });
    res.json({ tag: data.tag_name, name: data.name, url: data.html_url });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log("Listening on :3000"));
