<!-- Generated from shared/privacy.json by web/scripts/export-privacy.ts: edit that file, not this one. -->

# Privacidad

*Peryda para Mac, Windows y la web · Última actualización: 16 de noviembre de 2026*

[English](../../PRIVACY.md) · [Türkçe](../../docs/privacy/tr.md) · [Deutsch](../../docs/privacy/de.md)

## En resumen

- No hay cuenta ni servidor de Peryda; ni analítica, ni publicidad, ni seguimiento. Nada de lo que lees, escribes o preguntas llega al desarrollador.
- Las apps de Mac y Windows solo buscan versiones nuevas si tú lo permites.
- Tus libros, hilos, notas y ajustes se quedan en tu dispositivo.
- Cuando preguntas a Pery, la petición va directamente desde tu dispositivo al proveedor de IA que elegiste, con tu propia clave. Ese proveedor la trata según sus propios términos.

Este texto cubre Peryda para Mac, Windows y la web. Las apps de Peryda para iPhone y Android y Peryda Cloud tienen su propia política de privacidad: peryda.com/privacy

## Lo que se queda en tu dispositivo

- Los archivos PDF y EPUB que añades, tus posiciones de lectura, los hilos y sus tarjetas, las traducciones, las notas, el Diario del libro y tus ajustes. En el Mac se guardan en la carpeta aislada propia de Peryda; en Windows, en la carpeta de datos de Peryda de tu cuenta de Windows, y en la web, en el almacenamiento de este navegador para el sitio. En la web, borrar los datos del sitio los elimina. Quitar la app no basta: para eliminarlo todo, borra primero tus claves en los Ajustes de Peryda y luego quita la app; en el Mac borra además la carpeta Library/Containers/com.isnalcan.peryda.mac de tu carpeta de inicio, y en Windows marca al desinstalar la casilla que borra los datos de la aplicación.
- Una copia de seguridad que exportas es un archivo que guardas tú. Contiene tus libros y todo lo que escribiste u obtuviste en Peryda (hilos, traducciones, páginas extraídas, el diario), pero nunca tus claves, y no está cifrada.
- En el Mac, el texto de una página escaneada se lee en el propio Mac, con el reconocimiento de texto integrado de Apple, salvo que elijas «Extraer con Pery», que envía una imagen de la página a tu proveedor.
- Un libro no puede acceder a internet: Peryda no carga imágenes, fuentes, estilos ni scripts de la web dentro de un libro.

## Cómo se protegen tus claves

Tus claves se guardan solo en este dispositivo y se envían solo a su propio proveedor. En detalle:

- En el Mac se guardan en el llavero de macOS, que las cifra y las desbloquea cuando inicias sesión en tu Mac; otra app solo puede llegar a ellas si tú lo permites.
- En Windows y en la web se guardan en el almacenamiento propio de la app en este dispositivo, cifradas con AES-256. La clave que las descifra la genera el motor del navegador (en Windows, Microsoft Edge WebView2), que nunca la deja salir; por eso tus claves no aparecen como texto legible en ningún archivo.
- Conoce también el límite: este cifrado no protege del todo frente a alguien que pueda usar tu cuenta en el ordenador ni frente a software malicioso que se ejecute en él. En un ordenador compartido, desactiva «Recordar las claves en este dispositivo»: así tus claves no se guardan nunca y se olvidan al cerrar la app (en la web, al cerrar la página). En la web, además: una extensión del navegador con permiso para leer todos los sitios puede ver todo lo que hay en una página abierta; usa Peryda en un navegador con solo extensiones de confianza.
- Cada clave viaja por una conexión cifrada (HTTPS) solo a su propio proveedor, en la cabecera de la petición y nunca en la dirección. En Windows y en la web, la política de seguridad de la app (Content Security Policy) no permite conectarse a ninguna dirección salvo sus propios archivos y estos cuatro proveedores. Peryda no carga código de internet ni incluye scripts de otras empresas, como publicidad, analítica o widgets de chat.
- Tus claves nunca entran en las copias de seguridad ni en los archivos exportados.
- Nuestro consejo: crea una clave aparte para Peryda y fija un límite de gasto en tu proveedor. Si crees que una clave se ha filtrado, revócala en el sitio del proveedor; una clave revocada deja de funcionar al instante.
- Peryda es de código abierto: cualquiera puede comprobar en el código cómo se guardan y envían las claves (github.com/isnalcan/peryda-open).

## Lo que va a tu proveedor de IA

Solo cuando pides algo (una pregunta en un hilo, la traducción de una página, el texto de una página, un resumen del diario o la lista de modelos que tu clave puede usar), la app envía a tu proveedor lo que esa petición necesita:

- tu petición y los mensajes anteriores de ese hilo;
- el texto que seleccionaste con un breve pasaje alrededor, o una imagen de la parte de la página que seleccionaste;
- el título del libro y el número de página;
- para traducir una página, su texto, o una imagen de la página cuando no tiene texto propio; cuando eliges «Extraer con Pery», una imagen de cada página que elegiste;
- para un resumen del diario, las entradas del diario de ese libro.

Solo se envían las páginas que pides, y nada se envía por sí solo; un rango de páginas (como máximo 200 a la vez) envía cada una de sus páginas. Las peticiones viajan por una conexión cifrada (HTTPS) directamente al proveedor; no hay ningún servidor de Peryda en medio.

Cuando traduces o extraes más de dos páginas a la vez con Gemini, van como un trabajo por lotes a mitad de precio. Google ejecuta un trabajo durante 48 horas como máximo. Peryda borra el trabajo en Google cuando llegan los resultados (mientras ese libro está abierto en Peryda), cuando lo detienes o cuando cambias tu clave de Gemini. Google no dice cuánto tiempo guarda un trabajo terminado que no se ha borrado.

## Los términos de tu proveedor

El proveedor decide cuánto tiempo guarda lo que recibe y para qué puede usarlo. Lee sus términos antes de enviar textos personales o confidenciales. Conviene saber:

- API de Google Gemini: Google dice que en el nivel gratuito usa lo que envías para mejorar sus productos y que revisores humanos pueden leerlo, y que en el nivel de pago no lo usa así. Exige que quienes usan la API de Gemini tengan 18 años o más. Términos: ai.google.dev/gemini-api/terms
- DeepSeek dice que almacena los datos en la República Popular China. Política de privacidad: deepseek.com
- OpenAI: openai.com/policies · Anthropic (Claude): anthropic.com/legal/privacy

## Descargas, la app web y las actualizaciones

- Cuando descargas Peryda desde GitHub, a esa descarga se aplica la declaración de privacidad de GitHub.
- La app web la sirve Google Firebase Hosting, que trata datos de conexión como tu dirección IP para entregar sus archivos. Peryda no le ha añadido analítica ni registro de peticiones.
- En Windows, Peryda funciona dentro de Microsoft Edge WebView2, una parte de Windows que Microsoft mantiene actualizada.
- Las apps de Mac y Windows nunca buscan una versión nueva sin tu permiso. Te lo preguntan en el segundo inicio; si lo permites, piden a GitHub un pequeño archivo de versión más o menos una vez al día. Como en cualquier petición web, GitHub puede ver tu dirección IP y el nombre y la versión de la app que la hace. No se envía nada sobre tus libros, notas, claves ni tu ordenador. Puedes activar o desactivar esta búsqueda en Ajustes cuando quieras.
- Una actualización solo se instala si está firmada con la clave de actualización de Peryda; un archivo con una firma incorrecta, o modificado, se rechaza. Cuando encuentra una versión nueva, la app pregunta antes de instalarla; en el Mac también puedes elegir que las actualizaciones se instalen solas.
- La app web no comprueba nada aparte: cada vez que abres la página recibes la versión más reciente.

## Tus derechos

Como el desarrollador no recibe datos personales a través de estas apps, no tiene nada que mostrarte, corregir o borrar; puedes borrarlo todo tú mismo como se describe arriba. Para lo que tenga un proveedor, dirígete a ese proveedor. Peryda no pregunta tu edad ni guarda cuentas; los proveedores de IA fijan su propia edad mínima.

## Cambios y contacto

Los cambios en este texto se ven en el historial del proyecto en GitHub: github.com/isnalcan/peryda-open. Preguntas sobre privacidad: privacy@peryda.com. Para problemas de seguridad, consulta SECURITY.md en el proyecto.
