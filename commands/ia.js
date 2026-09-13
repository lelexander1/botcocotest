async function handleCommand(ctx) {
    const { sock, m, from, args, command, state, deps } = ctx;
    const { ai } = deps;

    if (command === 'si' && !state.encuestasDivorcio.has(from)) {
        try {
            const promptIa = "El usuario acaba de decir o invocar la palabra '#si'. Analiza esta palabra con sarcasmo o humor y respóndele de manera tajante, creativa o generando un concepto contrario como un rotundo 'No' o algo gracioso relacionado.";
            const res = await ai.models.generateContent({ model: 'gemini-3.6-flash', contents: promptIa });
            await sock.sendMessage(from, { text: `${res.text || '¡No!'}` }, { quoted: m });
        } catch {
            await sock.sendMessage(from, { text: '❌ ¡No!' }, { quoted: m });
        }
        return true;
    }

    if (command === 'ia' || command === 'gemini') {
        const pregunta = args.join(' ');
        if (!pregunta) {
            await sock.sendMessage(from, { text: '⚠️ Escribe qué deseas preguntarle a la IA.' }, { quoted: m });
            return true;
        }

        try {
            if (!state.chatHistoriales.has(from)) {
                state.chatHistoriales.set(from, []);
            }
            const historial = state.chatHistoriales.get(from);

            await sock.sendMessage(from, { text: '🧠 Pensando...' }, { quoted: m });

            const chat = ai.chats.create({
                model: 'gemini-3.6-flash',
                history: historial
            });

            const result = await chat.sendMessage({ message: pregunta });
            const respuestaTexto = result.text;

            historial.push({ role: 'user', parts: [{ text: pregunta }] });
            historial.push({ role: 'model', parts: [{ text: respuestaTexto }] });

            if (historial.length > 12) {
                historial.splice(0, 2);
            }

            await sock.sendMessage(from, { text: respuestaTexto }, { quoted: m });

        } catch (err) {
            console.error('Error detallado en la IA:', err);
            await sock.sendMessage(from, { text: '❌ Ocurrió un error al comunicarse con la IA.' }, { quoted: m });
        }
        return true;
    }

    return false;
}

module.exports = { handleCommand };