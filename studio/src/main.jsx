import React from "react";
import { createRoot } from "react-dom/client";
import ErgonStudio from "./ErgonStudio.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ErgonStudio />
  </React.StrictMode>
);
