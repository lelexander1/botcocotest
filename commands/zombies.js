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

        // INICIAR LOBBY
        if (!subCommand || subCommand === 'iniciar') {
            if (session) {
                await sock.sendMessage(from, { text: '⚠️ Ya hay una partida de supervivencia organizándose. Usa *#zombie unirse [rol]*.' }, { quoted: m });
                return true;
            }

            zombieSessions.set(from, {
                lider: sender,
                jugadores: new Map(), // Map de sender -> datos del jugador
                faseActual: 0,
                estado: 'reclutamiento',
                progresoFase: 0,
                pozo: 0
            });

            let texto = `🧟‍♂️ *¡LA FIEBRE DE LA BRUMA HA LLEGADO!* 🧟‍♀️\n\n`;
            texto += `Lima ha caído. La evacuación es en el Callao.\n💰 *Entrada:* 5,000 soles al pozo.\n🏆 *Premio:* 200,000 soles a los sobrevivientes.\n\n`;
            texto += `*ROLES DISPONIBLES:*\n`;
            texto += `🔫 *Mateo*: Ex-militar. Tanque.\n💉 *Valeria*: Paramédica. Healer.\n🔧 *Renzo*: Ingeniero. Especialista.\n🎒 *Lucia*: Cazadora. Loot (Frágil).\n\n`;
            texto += `💬 Escribe *#zombie unirse [rol]* (Ej: #zombie unirse renzo) para entrar.`;

            await sock.sendMessage(from, { text: texto }, { quoted: m });
            return true;
        }

        // UNIRSE AL JUEGO
        if (subCommand === 'unirse') {
            if (!session || session.estado !== 'reclutamiento') return false;

            const rolElegido = args[1]?.toLowerCase();
            if (!ROLES_INFO[rolElegido]) {
                await sock.sendMessage(from, { text: '❌ Debes elegir un rol válido: *mateo, valeria, renzo o lucia*.' }, { quoted: m });
                return true;
            }

            // Verificar si el rol ya fue tomado
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

            // Cobrar entrada
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
            return true;
        }

        // COMENZAR LA PARTIDA
        if (subCommand === 'comenzar') {
            if (!session || session.estado !== 'reclutamiento') return false;
            if (session.lider !== sender) {
                await sock.sendMessage(from, { text: '⚠️ Solo el líder del grupo puede iniciar la huida.' }, { quoted: m });
                return true;
            }

            session.estado = 'jugando';
            session.faseActual = 1;
            session.pozo = 200000; // El premio mayor al llegar al Callao

            let textoFase1 = `📍 *FASE 1: EL DESPERTAR EN LA MOLINA*\n\n`;
            textoFase1 += `El refugio ha sido comprometido. La bruma cubre las calles de La Molina y deben salir hacia Javier Prado.\n\n`;
            textoFase1 += `⚠️ *Evento:* Un grupo de sobrevivientes paranoicos bloquea la reja principal.\n`;
            textoFase1 += `💬 Usa *#accion [lo que haces]* para resolver la situación, o *#saquear* para buscar suministros.`;

            await sock.sendMessage(from, { text: textoFase1 }, { quoted: m });
            return true;
        }
    }
    return false;
}

module.exports = { handleCommand, zombieSessions, ROLES_INFO };