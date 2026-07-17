// netlify/functions/radar-cron.js
// RADAR DIARIO: todos los días a las 7:00 am (hora CDMX) el director recibe
// por correo el tablero de cobranza con los datos del momento.
// (13:00 UTC = 7:00 am CDMX. Los recordatorios a clientes salen aparte, 8:00 L-V.)
import { enviarRadar } from "./lib/cobranza-radar.js";

export default async () => {
  try {
    const r = await enviarRadar();
    console.log("Radar enviado a", r.destino, JSON.stringify(r.resumen));
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("Radar cron ERROR:", e);
    return new Response("error", { status: 500 });
  }
};

export const config = { schedule: "0 13 * * *" };
