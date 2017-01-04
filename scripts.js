$(function() {
  var author = $('#author');
  var text = $('#quote-text');
  getQuote(author, text);

  $('#getQuote').click(function(event) {
    event.preventDefault();
    getQuote(author, text);
  })
});

function getQuote(author, text) {

  var forismaticURL = "http://api.forismatic.com/api/1.0/?method=getQuote&lang=en&format=jsonp&jsonp=?"

  $.getJSON(forismaticURL, function(json) {
      //$(".quote").html(JSON.stringify(json));
      text.html(json.quoteText);
    if (json.quoteAuthor) {
      author.html(json.quoteAuthor);
      author.attr("href", json.quoteLink);
    } else {
      author.removeAttr("href");
      author.html("<strong>Anonymous</strong>");
    }
  });
}
