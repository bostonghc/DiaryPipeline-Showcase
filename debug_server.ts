
import express from "express";

const app = express();
const PORT = 3000;

app.get("/", (req, res) => {
  res.send("<h1>Server is alive!</h1><p>If you see this, the server is working.</p>");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Debug server running on http://localhost:${PORT}`);
});
