import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import App from "./App"
import { NewsroomCase } from "./NewsroomCase"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		{location.pathname.replace(/\/$/, "") === "/newsroom" ? <NewsroomCase /> : <App />}
	</StrictMode>,
)
