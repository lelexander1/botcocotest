const zombieSessions = new Map();

const ROLES_INFO = {
    mateo: { nombre: 'Mateo (Ex-Militar)', vida: 100, debuff: 'sordera', desc: 'Dispara y defiende. Falla si abusa de las armas.' },
    valeria: { nombre: 'Valeria (Paramédica)', vida: 80, debuff: 'temblor', desc: 'Cura heridos. Falla bajo mucha presión.' },
    renzo: { nombre: 'Renzo (Ingeniero)', vida: 90, debuff: 'claustrofobia', desc: 'Trampas y hackeo. Pierde tiempo o entra en pánico en lugares cerrados.' },
    lucia: { nombre: 'Lucía (Cazadora)', vida: 50, debuff: 'avaricia', desc: 'Busca botín. Recibe el doble de daño por ser frágil.' }
};

async function handleCommand(ctx) {
    const { sock, m, from, sender, args, command, usersCollection, economyCollection } = ctx;
    const db = usersCollection || economyCollection;

    if (command === 'zombie' || command === 'zombies') {
        const subCommand = args[0]?.toLowerCase();
        let session = zombieSessions.get(from);

        if (!subCommand || subCommand === 'iniciar') {
            if (session) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay una partida de supervivencia organizándose. Usa *#zombie unirse [rol]*.' }, { quoted: m });
                return true;
            }

            const nuevaSesion = {
                lider: sender,
                jugadores: new Map(),
                faseActual: 0,
                estado: 'reclutamiento',
                progresoFase: 0,
                pozo: 0,
                dbRef: db
            };

            zombieSessions.set(from, nuevaSesion);

            let texto = `🧟‍♂️ *¡LA FIEBRE DE LA BRUMA HA LLEGADO!* 🧟‍♀️\n\n`;
            texto += `Lima ha caído. La evacuación es en el Callao.\n👥 Se necesitan *4 sobrevivientes* (o iniciará automáticamente en 5 minutos).\n`;
            texto += `💰 *Entrada:* 5,000 soles al pozo.\n🏆 *Premio:* 100,000 soles a los sobrevivientes.\n💀 *Modo:* ¡A todo o nada (si mueres pierdes todo tu dinero)!\n\n`;
            texto += `*ROLES DISPONIBLES:*\n`;
            texto += `🔫 *Mateo*: Ex-militar. Tanque.\n💉 *Valeria*: Paramédica. Healer.\n🔧 *Renzo*: Ingeniero. Especialista.\n🎒 *Lucia*: Cazadora. Loot (Frágil).\n\n`;
            texto += `💬 Escribe *#zombie unirse [rol]* (Ej: #zombie unirse renzo) para entrar.`;

            await sock.sendMessage(from, { text: texto }, { quoted: m });

            // Temporizador de 5 minutos (300,000 ms) por si no se completan los 4
            nuevaSesion.timeoutInicio = setTimeout(async () => {
                let currentSession = zombieSessions.get(from);
                if (currentSession && currentSession.estado === 'reclutamiento') {
                    if (currentSession.jugadores.size > 0) {
                        await sock.sendMessage(from, { text: `⏰ *¡TIEMPO AGOTADO!* No se completaron los 4 cupos. El convoy arranca de emergencia con los ${currentSession.jugadores.size} sobrevivientes inscritos.` });
                        await arrancarJuego(sock, from, currentSession);
                    } else {
                        zombieSessions.delete(from);
                        await sock.sendMessage(from, { text: `⏰ La sala de supervivencia expiró por falta de jugadores.` });
                    }
                }
            }, 300000);

            return true;
        }

        if (subCommand === 'unirse') {
            if (!session || session.estado !== 'reclutamiento') {
                await sock.sendMessage(from, { text: '❌ No hay ninguna sala de supervivencia abierta para unirse.' }, { quoted: m });
                return true;
            }

            const rolElegido = args[1]?.toLowerCase();
            if (!ROLES_INFO[rolElegido]) {
                await sock.sendMessage(from, { text: '❌ Debes elegir un rol válido: *mateo, valeria, renzo o lucia*.' }, { quoted: m });
                return true;
            }

            for (let [jugador, datos] of session.jugadores.entries()) {
                if (datos.rolKey === rolElegido) {
                    await sock.sendMessage(from, { text: `⚠️ El rol de *${ROLES_INFO[rolElegido].nombre}* ya fue tomado por alguien más.` }, { quoted: m });
                    return true;
                }
            }

            if (session.jugadores.has(sender)) {
                await sock.sendMessage(from, { text: '⚠️ Ya estás en el equipo.' }, { quoted: m });
                return true;
            }

            if (db) {
                const userEco = await db.findOne({ jid: sender });
                const saldo = userEco?.soles || userEco?.wallet || 0;
                if (saldo < 5000) {
                    await sock.sendMessage(from, { text: `❌ Necesitas 💰 *5,000 soles* para pagar tu lugar en el convoy.` }, { quoted: m });
                    return true;
                }
                await db.updateOne({ jid: sender }, { $inc: { soles: -5000 } });
            }

            session.jugadores.set(sender, {
                rolKey: rolElegido,
                vida: ROLES_INFO[rolElegido].vida,
                inventario: { medicinas: 1, bebidas: 1, balas: 2 },
                vivo: true
            });
            session.pozo += 5000;

            await sock.sendMessage(from, { 
                text: `✅ @${sender.split('@')[0]} se ha unido como *${ROLES_INFO[rolElegido].nombre}*.\nSobrevivientes listos: ${session.jugadores.size}/4.`,
                mentions: [sender]
            }, { quoted: m });

            // Si se completan exactamente los 4 cupos, arranca de inmediato y cancela el temporizador
            if (session.jugadores.size === 4) {
                clearTimeout(session.timeoutInicio);
                await arrancarJuego(sock, from, session);
            }
            return true;
        }

        if (subCommand === 'comenzar') {
            if (!session || session.estado !== 'reclutamiento') return false;
            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder del grupo puede iniciar la huida antes.' }, { quoted: m });
                return true;
            }
            if (session.jugadores.size === 0) {
                await sock.sendMessage(from, { text: '⚠️ No hay jugadores en el equipo todavía.' }, { quoted: m });
                return true;
            }

            clearTimeout(session.timeoutInicio);
            await arrancarJuego(sock, from, session);
            return true;
        }
    }
    return false;
}

async function arrancarJuego(sock, from, session) {
    session.estado = 'jugando';
    session.faseActual = 1;
    session.pozo = 100000; // Premio ajustado a 100,000 soles

    let textoFase1 = `📍 *FASE 1: EL DESPERTAR EN LA MOLINA*\n\n`;
    textoFase1 += `El refugio ha sido comprometido. La bruma cubre las calles y deben salir hacia Javier Prado con ${session.jugadores.size} miembro(s).\n\n`;
    textoFase1 += `⚠️ *Evento:* Un grupo de sobrevivientes paranoicos bloquea la reja principal.\n`;
    textoFase1 += `💬 Usa *#accion [lo que haces]* para resolver la situación, o *#saquear* para buscar suministros.`;

    await sock.sendMessage(from, { text: textoFase1 });
}

module.exports = { handleCommand, zombieSessions, ROLES_INFO };