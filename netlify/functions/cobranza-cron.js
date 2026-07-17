// netlify/functions/cobranza-cron.js
// FUNCIÓN PROGRAMADA: corre sola de lunes a viernes a las 8:00 am (hora CDMX),
// evalúa toda la cartera y dispara los correos que toquen según la cadencia.
// Nadie tiene que acordarse de nada. (14:00 UTC = 8:00 am CDMX)
import { correrCobranza } from "./lib/cobranza-motor.js";

export default async () => {
  try {
    const r = await correrCobranza({ enviar: true });
    console.log("Cobranza cron:", JSON.stringify(r.resumen), "enviados:", JSON.stringify(r.enviados));
    return new Response(JSON.stringify(r.resumen), { status: 200 });
  } catch (e) {
    console.error("Cobranza cron ERROR:", e);
    return new Response("error", { status: 500 });
  }
};

export const config = { schedule: "0 14 * * 1-5" };
