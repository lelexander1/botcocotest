const { heistSessions } = require('./heist');

async function handleCommand(ctx) {
    const { sock, m, from, sender, command, economyCollection } = ctx;

    let session = heistSessions.get(from);

    if (session && session.fase === 'decision_herido') {
        if (command === 'ayudar' || command === 'abandonar') {
            clearTimeout(session.decisonTimer);
            heistSessions.delete(from);

            const totalJugadores = session.participantes.length;
            let mensajeFinal = '';
            let gananciaPorPersona = 0;

            if (command === 'ayudar') {
                // Ayudar reduce un poco el botín total por el peso y retraso, pero todos sobreviven con ganancias limpias
                const botinReducido = Math.floor(session.botinActual * 0.7);
                gananciaPorPersona = Math.floor(botinReducido / totalJugadores);

                mensajeFinal = `🤝 *¡DECISIÓN SOLIDARIA!* El equipo arriesgó segundos valiosos cargando a @${session.usuarioHerido.split('@')[0]}. Lograron escapar por los túneles subterráneos.\n\n`;
                mensajeFinal += `💵 Botín repartido: *+${gananciaPorPersona} monedas* para cada sobreviviente. ¡Nadie murió!`;

            } else {
                // Abandonar deja al herido atrás, el botín se reparte solo entre los demás (si hay más de 1)
                mensajeFinal = `🏃💨 *¡HUIDA COBARDE!* Decidieron dejar atrás a @${session.usuarioHerido.split('@')[0]} para salvar el pellejo.\n\n`;
                
                if (totalJugadores > 1) {
                    const sanos = totalJugadores - 1;
                    gananciaPorPersona = Math.floor(session.botinActual / sanos);
                    mensajeFinal += `💵 El botín completo se repartió entre los ${sanos} restantes: *+${gananciaPorPersona} monedas* cada uno.\n🚑 Su compañero fue arrestado.`;
                } else {
                    mensajeFinal += `Estabas tú solo... Te atraparon intentando huir sin ayuda. ¡Perdiste todo!`;
                    gananciaPorPersona = -1000; // Pérdida total de la inversión
                }
            }

            // Aplicar pagos en la base de datos de economía
            if (economyCollection) {
                for (const participante of session.participantes) {
                    // Si decidió abandonar, el herido no recibe nada o pierde
                    if (command === 'abandonar' && participante === session.usuarioHerido) {
                        continue; 
                    }
                    if (gananciaPorPersona > 0) {
                        await economyCollection.updateOne(
                            { userId: participante },
                            { $inc: { wallet: gananciaPorPersona } },
                            { upsert: true }
                        );
                    }
                }
            }

            const mentions = [...session.participantes];
            await sock.sendMessage(from, { text: mensajeFinal, mentions }, { quoted: m });
            return true;
        }
    }

    return false;
}

module.exports = { handleCommand };