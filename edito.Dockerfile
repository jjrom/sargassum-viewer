FROM nginx:1.27.4-perl

COPY ./index.html /usr/share/nginx/html/index.html
COPY ./styles.css /usr/share/nginx/html/styles.css
COPY ./app.js /usr/share/nginx/html/app.js
COPY ./data /usr/share/nginx/html/data
COPY ./img /usr/share/nginx/html/img
COPY ./lib /usr/share/nginx/html/lib

EXPOSE 80