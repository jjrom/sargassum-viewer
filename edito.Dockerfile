FROM nginx:1.27.4-perl

COPY ./*.html /usr/share/nginx/html/
COPY ./*.css /usr/share/nginx/html/
COPY ./*.js /usr/share/nginx/html/
COPY ./data /usr/share/nginx/html/data
COPY ./img /usr/share/nginx/html/img
COPY ./lib /usr/share/nginx/html/lib

EXPOSE 80