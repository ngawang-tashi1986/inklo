import React from "react";
import ReactDOM from "react-dom/client";
import "./css/app.css";
import { App } from "./ts/features/meeting/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
