<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Privacidad

*Peryda para Mac, Windows y la web · Última actualización: 13 de noviembre de 2026*

[English](../../PRIVACY.md) · [Türkçe](../../docs/privacy/tr.md) · [Deutsch](../../docs/privacy/de.md)

## En resumen

- No hay cuenta ni servidor de Peryda; ni analítica, ni publicidad, ni seguimiento. Nada de lo que lees, escribes o preguntas llega al desarrollador.
- Tus libros, hilos, notas y ajustes se quedan en tu dispositivo.
- Cuando preguntas a Pery, la petición va directamente desde tu dispositivo al proveedor de IA que elegiste, con tu propia clave. Ese proveedor la trata según sus propios términos.

Este texto cubre Peryda para Mac, Windows y la web. Las apps de Peryda para iPhone y Android y Peryda Cloud tienen su propia política de privacidad: peryda.com/privacy

## Lo que se queda en tu dispositivo

- Los archivos PDF y EPUB que añades, tus posiciones de lectura, los hilos y sus tarjetas, las traducciones, las notas, el Diario del libro y tus ajustes. En el Mac se guardan en la carpeta aislada propia de Peryda; en Windows, en la carpeta de datos de Peryda de tu cuenta de Windows, y en la web, en el almacenamiento de este navegador para el sitio. Quitar la app o borrar los datos del sitio los elimina.
- Tus claves de IA: en el Mac, en el llavero de macOS; en Windows y en la web, en el almacenamiento propio de la app, cifradas con una clave que el motor del navegador nunca deja salir. Alguien que pueda usar tu cuenta en el ordenador podría llegar a ellas igualmente, así que en un ordenador compartido desactiva «Recordar las claves en este dispositivo». Cada clave se envía solo a su propio proveedor.
- Una copia de seguridad que exportas es un archivo que guardas tú. Nunca contiene tus claves y no está cifrada.
- En el Mac, el texto de una página escaneada se lee en el propio Mac, con el reconocimiento de texto integrado de Apple.
- Un libro no puede acceder a internet: Peryda no carga imágenes, fuentes, estilos ni scripts de la web dentro de un libro.

## Lo que va a tu proveedor de IA

Solo cuando pides algo (una pregunta en un hilo, la traducción de una página, el texto de una página, un resumen del diario o la lista de modelos que tu clave puede usar), la app envía a tu proveedor lo que esa petición necesita:

- tu petición y los mensajes anteriores de ese hilo;
- el texto que seleccionaste con un breve pasaje alrededor, o una imagen de la parte de la página que seleccionaste;
- el título del libro y el número de página;
- para traducir una página, su texto; en Windows y en la web, una imagen de la página cuando no tiene texto propio (también cuando pides el texto de una página);
- para un resumen del diario, las entradas del diario de ese libro.

Nunca se envía el libro entero. Las peticiones viajan por una conexión cifrada (HTTPS) directamente al proveedor; no hay ningún servidor de Peryda en medio.

Cuando traduces muchas páginas a la vez con Gemini, van como un trabajo por lotes a mitad de precio. Google guarda el trabajo hasta que termina, como máximo 48 horas; Peryda lo borra en cuanto llegan las traducciones o cuando detienes la traducción.

## Los términos de tu proveedor

El proveedor decide cuánto tiempo guarda lo que recibe y para qué puede usarlo. Lee sus términos antes de enviar textos personales o confidenciales. Conviene saber:

- API de Google Gemini: Google dice que en el nivel gratuito usa lo que envías para mejorar sus productos y que revisores humanos pueden leerlo, y que en el nivel de pago no lo usa así. Exige que quienes usan la API de Gemini tengan 18 años o más. Términos: ai.google.dev/gemini-api/terms
- DeepSeek dice que almacena los datos en la República Popular China. Política de privacidad: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Descargas, la app web y las actualizaciones

- Cuando descargas Peryda desde GitHub, a esa descarga se aplica la declaración de privacidad de GitHub.
- La app web la sirve Google Firebase Hosting, que trata datos de conexión como tu dirección IP para entregar sus archivos. Peryda no le ha añadido analítica ni registro de peticiones.
- En Windows, Peryda funciona dentro de Microsoft Edge WebView2, una parte de Windows que Microsoft mantiene actualizada.
- Las apps no buscan actualizaciones por sí solas.

## Tus derechos

Como el desarrollador no recibe datos personales a través de estas apps, no tiene nada que mostrarte, corregir o borrar; puedes borrarlo todo tú mismo como se describe arriba. Para lo que tenga un proveedor, dirígete a ese proveedor. Peryda no pregunta tu edad ni guarda cuentas; los proveedores de IA fijan su propia edad mínima.

## Cambios y contacto

Los cambios en este texto se ven en el historial del proyecto en GitHub: github.com/isnalcan/peryda-open. Preguntas sobre privacidad: privacy@peryda.com. Para problemas de seguridad, consulta SECURITY.md en el proyecto.
